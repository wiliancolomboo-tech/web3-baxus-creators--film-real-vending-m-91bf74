import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusVendingMachine } from "../target/types/baxus_vending_machine";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import * as crypto from "crypto";

describe("BAXUS Vending Machine - End-to-End Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusVendingMachine as Program<BaxusVendingMachine>;

  const machineId = new anchor.BN(42);
  const spinPrice = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
  const tierWeights = [7000, 2400, 550, 50]; // Total = 10,000

  const authority = Keypair.generate();
  const keeper = Keypair.generate();
  const treasury = Keypair.generate();
  const player = Keypair.generate();

  let prizeMint: PublicKey;
  let authorityPrizeAta: PublicKey;
  let escrowVaultAta: PublicKey;
  let playerPrizeAta: PublicKey;

  let configPda: PublicKey;
  let poolPda: PublicKey;
  let escrowAuthorityPda: PublicKey;
  let spinStatePda: PublicKey;

  before(async () => {
    // Airdrop accounts
    for (const kp of [authority, keeper, player]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("machine"), machineId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), machineId.toArrayLike(Buffer, "le", 8), Buffer.from([0])], // Tier 0 = Common
      program.programId
    );

    [escrowAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), machineId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [spinStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("spin"),
        machineId.toArrayLike(Buffer, "le", 8),
        player.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Create RWA Bottle Mint (Simulating 1-of-1 BAXUS Vault Bottle Receipt)
    prizeMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      0
    );

    authorityPrizeAta = await createAccount(
      provider.connection,
      authority,
      prizeMint,
      authority.publicKey
    );

    escrowVaultAta = await createAccount(
      provider.connection,
      authority,
      prizeMint,
      escrowAuthorityPda
    );

    playerPrizeAta = await createAccount(
      provider.connection,
      player,
      prizeMint,
      player.publicKey
    );

    // Mint 1 bottle token to authority
    await mintTo(provider.connection, authority, prizeMint, authorityPrizeAta, authority, 1);
  });

  it("Initializes the BAXUS Vending Machine with Tier Weights", async () => {
    await program.methods
      .initializeMachine(machineId, spinPrice, tierWeights)
      .accounts({
        config: configPda,
        treasury: treasury.publicKey,
        keeper: keeper.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority, keeper])
      .rpc();

    const config = await program.account.vendingMachineConfig.fetch(configPda);
    assert.isTrue(config.machineId.eq(machineId));
    assert.equal(config.spinPriceLamports.toNumber(), spinPrice.toNumber());
    assert.deepEqual(config.tierWeightsBps, tierWeights);
  });

  it("Initializes Tier Pool and Deposits RWA Token into Escrow PDA", async () => {
    // 1. Initialize Pool for Tier 0
    await program.methods
      .initializeTierPool(machineId, 0)
      .accounts({
        config: configPda,
        prizePool: poolPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    // 2. Deposit Prize
    await program.methods
      .depositPrize(machineId, 0)
      .accounts({
        config: configPda,
        prizePool: poolPda,
        prizeMint: prizeMint,
        depositorTokenAccount: authorityPrizeAta,
        escrowVaultAuthority: escrowAuthorityPda,
        escrowVaultTokenAccount: escrowVaultAta,
        depositor: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const pool = await program.account.prizePool.fetch(poolPda);
    assert.equal(pool.itemCount, 1);
    assert.equal(pool.prizeMints[0].toBase58(), prizeMint.toBase58());

    const escrowToken = await getAccount(provider.connection, escrowVaultAta);
    assert.equal(Number(escrowToken.amount), 1);
  });

  it("Executes Spin Commit Request (User deposits lamports)", async () => {
    const clientSeed = crypto.randomBytes(32);
    const treasuryBalanceBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .requestSpin(machineId, Array.from(clientSeed))
      .accounts({
        config: configPda,
        spinState: spinStatePda,
        user: player.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc();

    const treasuryBalanceAfter = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(
      treasuryBalanceAfter - treasuryBalanceBefore,
      spinPrice.toNumber(),
      "Treasury must receive exact spin price"
    );

    const spinState = await program.account.spinState.fetch(spinStatePda);
    assert.isTrue(spinState.isPending);
    assert.equal(spinState.user.toBase58(), player.publicKey.toBase58());
  });

  it("Resolves Spin via Reveal and Dispenses RWA Token to Player", async () => {
    // Wait 2 slots to satisfy commit window
    let currentSlot = await provider.connection.getSlot();
    const spinStateBefore = await program.account.spinState.fetch(spinStatePda);
    while (currentSlot < spinStateBefore.targetSlot.toNumber()) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      currentSlot = await provider.connection.getSlot();
    }

    // Keeper supplies entropy seed
    const keeperEntropy = crypto.randomBytes(32);

    await program.methods
      .resolveSpin(machineId, Array.from(keeperEntropy))
      .accounts({
        config: configPda,
        spinState: spinStatePda,
        prizePool: poolPda,
        prizeMint: prizeMint,
        escrowVaultAuthority: escrowAuthorityPda,
        escrowVaultTokenAccount: escrowVaultAta,
        userPrizeTokenAccount: playerPrizeAta,
        user: player.publicKey,
        caller: keeper.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    // Verify Player received the 1-of-1 RWA token
    const playerToken = await getAccount(provider.connection, playerPrizeAta);
    assert.equal(Number(playerToken.amount), 1, "Player should have received won RWA bottle");

    // Verify escrow balance is 0
    const escrowToken = await getAccount(provider.connection, escrowVaultAta);
    assert.equal(Number(escrowToken.amount), 0, "Escrow should now be empty");

    // Verify spin state is marked resolved
    const spinStateAfter = await program.account.spinState.fetch(spinStatePda);
    assert.isFalse(spinStateAfter.isPending);
  });
});