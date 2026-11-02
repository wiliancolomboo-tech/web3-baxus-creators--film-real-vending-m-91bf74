import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusVending } from "../target/types/baxus_vending";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("BAXUS Vending: On-Chain Dispense & Video Attestation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusVending as Program<BaxusVending>;

  const admin = Keypair.generate();
  const hardwareOracle = Keypair.generate();
  const treasury = Keypair.generate();
  const user = Keypair.generate();

  const machineId = 101;
  const spinPrice = new anchor.BN(0.25 * LAMPORTS_PER_SOL);
  let bottleMint: PublicKey;
  let adminBottleAta: PublicKey;
  let userBottleAta: PublicKey;

  let vendingMachinePda: PublicKey;
  let bottleInventoryPda: PublicKey;
  let vaultTokenPda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdropSigners = [admin, hardwareOracle, treasury, user];
    for (const s of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(s.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Derive Program PDAs
    const machineIdBuffer = Buffer.alloc(4);
    machineIdBuffer.writeUInt32LE(machineId);

    [vendingMachinePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vending_machine"), machineIdBuffer],
      program.programId
    );

    // Mint Mock BAXUS Bottle RWA NFT
    bottleMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      0
    );

    adminBottleAta = await createAccount(
      provider.connection,
      admin,
      bottleMint,
      admin.publicKey
    );

    userBottleAta = await createAccount(
      provider.connection,
      user,
      bottleMint,
      user.publicKey
    );

    await mintTo(
      provider.connection,
      admin,
      bottleMint,
      adminBottleAta,
      admin.publicKey,
      1
    );

    [bottleInventoryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bottle"), machineIdBuffer, bottleMint.toBuffer()],
      program.programId
    );

    [vaultTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), machineIdBuffer, bottleMint.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the physical vending machine configuration", async () => {
    await program.methods
      .initializeMachine(machineId, spinPrice)
      .accounts({
        authority: admin.publicKey,
        hardwareOracle: hardwareOracle.publicKey,
        treasury: treasury.publicKey,
        vendingMachine: vendingMachinePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const machineAccount = await program.account.vendingMachine.fetch(vendingMachinePda);
    expect(machineAccount.machineId).to.equal(machineId);
    expect(machineAccount.hardwareOracle.toBase58()).to.equal(hardwareOracle.publicKey.toBase58());
    expect(machineAccount.spinPrice.toNumber()).to.equal(spinPrice.toNumber());
    expect(machineAccount.isActive).to.be.true;
  });

  it("2. Stocks a rare whiskey bottle NFT into machine vault PDA", async () => {
    await program.methods
      .stockBottle(machineId, 3) // Tier 3 = Grail Macallan
      .accounts({
        authority: admin.publicKey,
        vendingMachine: vendingMachinePda,
        bottleMint: bottleMint,
        authorityTokenAccount: adminBottleAta,
        bottleInventory: bottleInventoryPda,
        vaultTokenAccount: vaultTokenPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultTokenPda);
    expect(Number(vaultBalance.amount)).to.equal(1);

    const inv = await program.account.bottleInventory.fetch(bottleInventoryPda);
    expect(inv.rarityTier).to.equal(3);
    expect(inv.isDispensed).to.be.false;
  });

  it("3. User requests a spin, locks funds into treasury, creates SpinSession PDA", async () => {
    const nonce = new anchor.BN(Date.now());
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(nonce.toString()));

    const [spinSessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spin_session"), user.publicKey.toBuffer(), nonceBuffer],
      program.programId
    );

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .requestSpin(machineId, nonce)
      .accounts({
        user: user.publicKey,
        vendingMachine: vendingMachinePda,
        targetBottleInventory: bottleInventoryPda,
        spinSession: spinSessionPda,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    expect(treasuryAfter - treasuryBefore).to.equal(spinPrice.toNumber());

    const session = await program.account.spinSession.fetch(spinSessionPda);
    expect(session.user.toBase58()).to.equal(user.publicKey.toBase58());
    expect(session.targetBottleMint.toBase58()).to.equal(bottleMint.toBase58());
    expect(session.status).to.deep.equal({ awaitingPhysicalDispense: {} });
  });

  it("4. Hardware Oracle attests physical dispense, hashes video, and unlocks NFT", async () => {
    const nonce = new anchor.BN(Date.now()); // Previous test session nonce
    // To cleanly demo, make an atomic spin and attest pipeline:
    const specificNonce = new anchor.BN(42069);
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(42069));

    const [spinSessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spin_session"), user.publicKey.toBuffer(), nonceBuffer],
      program.programId
    );

    // Execute Request Spin
    await program.methods
      .requestSpin(machineId, specificNonce)
      .accounts({
        user: user.publicKey,
        vendingMachine: vendingMachinePda,
        targetBottleInventory: bottleInventoryPda,
        spinSession: spinSessionPda,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Camera Rig simulates HD footage capture & IPFS SHA-256 computation
    const simulatedIpfsHash = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
    const videoCidBytes = Buffer.alloc(64);
    videoCidBytes.write(simulatedIpfsHash, "utf-8");

    const telemetryHash = crypto.createHash("sha256").update("MOTOR_SLOT_07_DISPENSE_SUCCESS").digest();

    // Attest transaction submitted from physical machine IoT signer
    await program.methods
      .attestDispenseAndFilm(
        Array.from(videoCidBytes),
        Array.from(telemetryHash)
      )
      .accounts({
        hardwareOracle: hardwareOracle.publicKey,
        recipient: user.publicKey,
        vendingMachine: vendingMachinePda,
        spinSession: spinSessionPda,
        bottleMint: bottleMint,
        bottleInventory: bottleInventoryPda,
        vaultTokenAccount: vaultTokenPda,
        recipientTokenAccount: userBottleAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([hardwareOracle])
      .rpc();

    // Verify physical state update
    const session = await program.account.spinSession.fetch(spinSessionPda);
    expect(session.status).to.deep.equal({ dispensedAndFilmed: {} });

    // Verify user received the physical tokenized RWA bottle NFT
    const userAtaBalance = await getAccount(provider.connection, userBottleAta);
    expect(Number(userAtaBalance.amount)).to.equal(1);

    const vaultBalance = await getAccount(provider.connection, vaultTokenPda);
    expect(Number(vaultBalance.amount)).to.equal(0);
  });
});