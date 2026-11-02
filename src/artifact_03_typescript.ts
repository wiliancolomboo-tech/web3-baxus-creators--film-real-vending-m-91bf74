// tests/baxus-vending.ts
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
import { assert, expect } from "chai";
import * as crypto from "crypto";

describe("baxus_vending physical spin & proof tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusVending as Program<BaxusVending>;

  const machineAuthority = anchor.web3.Keypair.generate();
  const keeperAuthority = anchor.web3.Keypair.generate();
  const user = anchor.web3.Keypair.generate();
  const treasury = anchor.web3.Keypair.generate();

  let paymentMint: anchor.web3.Pubkey;
  let userAta: anchor.web3.Pubkey;
  let treasuryAta: anchor.web3.Pubkey;
  let machinePda: anchor.web3.Pubkey;
  let escrowVaultPda: anchor.web3.Pubkey;

  const machineId = new anchor.BN(42);
  const dispenseFee = new anchor.BN(50_000_000); // 50 USDC (6 decimals)
  const slotZeroIndex = 0;
  const sampleSku = Buffer.from("BAXUS-WHISKY-001"); // 16 bytes

  before(async () => {
    // Fund actors with SOL
    for (const actor of [machineAuthority, keeperAuthority, user, treasury]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    // Create Payment Mint (e.g. Mock USDC)
    paymentMint = await createMint(
      provider.connection,
      machineAuthority,
      machineAuthority.publicKey,
      null,
      6
    );

    userAta = await createAccount(provider.connection, user, paymentMint, user.publicKey);
    treasuryAta = await createAccount(provider.connection, treasury, paymentMint, treasury.publicKey);

    // Mint 500 USDC to user
    await mintTo(
      provider.connection,
      machineAuthority,
      paymentMint,
      userAta,
      machineAuthority,
      500_000_000
    );

    // Derive PDAs
    [machinePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("machine"), machineId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [escrowVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("escrow"), machineId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  });

  it("1. Initializes Physical Vending Machine PDA and Token Escrow", async () => {
    const tx = await program.methods
      .initializeMachine(machineId, dispenseFee, keeperAuthority.publicKey)
      .accounts({
        machine: machinePda,
        paymentMint: paymentMint,
        escrowVault: escrowVaultPda,
        authority: machineAuthority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([machineAuthority])
      .rpc();

    const machineAccount = await program.account.vendingMachine.fetch(machinePda);
    expect(machineAccount.machineId.toNumber()).to.equal(42);
    expect(machineAccount.dispenseFee.toNumber()).to.equal(50_000_000);
    expect(machineAccount.keeperAuthority.toBase58()).to.equal(keeperAuthority.publicKey.toBase58());
    expect(machineAccount.activeInventoryCount).to.equal(0);
  });

  it("2. Registers an RWA bottle slot in inventory", async () => {
    const [bottleSlotPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("bottle"), machinePda.toBuffer(), Buffer.from([slotZeroIndex])],
      program.programId
    );

    await program.methods
      .registerBottle(slotZeroIndex, Array.from(sampleSku), 3) // Tier 3 = Grail
      .accounts({
        machine: machinePda,
        bottleSlot: bottleSlotPda,
        authority: machineAuthority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([machineAuthority])
      .rpc();

    const slotAccount = await program.account.bottleSlot.fetch(bottleSlotPda);
    expect(slotAccount.slotIndex).to.equal(0);
    expect(slotAccount.bottleTier).to.equal(3);
    expect(slotAccount.isAvailable).to.be.true;

    const machineAccount = await program.account.vendingMachine.fetch(machinePda);
    expect(machineAccount.activeInventoryCount).to.equal(1);
  });

  it("3. User triggers on-chain spin: Escrows 50 USDC & initializes session", async () => {
    const userEntropy = crypto.randomBytes(32);
    const sessionCounter = new anchor.BN(0);

    const [spinSessionPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("session"), machinePda.toBuffer(), sessionCounter.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const initialUserBal = (await getAccount(provider.connection, userAta)).amount;

    await program.methods
      .initiateSpin(Array.from(userEntropy))
      .accounts({
        machine: machinePda,
        spinSession: spinSessionPda,
        escrowVault: escrowVaultPda,
        userTokenAccount: userAta,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const postUserBal = (await getAccount(provider.connection, userAta)).amount;
    expect(Number(initialUserBal - postUserBal)).to.equal(50_000_000);

    const escrowBal = (await getAccount(provider.connection, escrowVaultPda)).amount;
    expect(Number(escrowBal)).to.equal(50_000_000);

    const sessionAccount = await program.account.spinSession.fetch(spinSessionPda);
    expect(sessionAccount.user.toBase58()).to.equal(user.publicKey.toBase58());
    expect(sessionAccount.status).to.deep.equal({ pendingPhysicalDispense: {} });
  });

  it("4. Hardware Keeper senses physical drop, hashes filmed video MP4, and confirms dispense", async () => {
    const sessionCounter = new anchor.BN(0);
    const [spinSessionPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("session"), machinePda.toBuffer(), sessionCounter.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [bottleSlotPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("bottle"), machinePda.toBuffer(), Buffer.from([slotZeroIndex])],
      program.programId
    );

    // Mock Creator 4K Video Payload & IPFS CID
    const rawCreatorVideoPayload = Buffer.from("BAXUS_CREATOR_RAW_FOOTAGE_CAMERA_SPIN_TOKEN2049_SERIAL_99812");
    const videoHash = crypto.createHash("sha256").update(rawCreatorVideoPayload).digest();
    
    // QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco (46 bytes)
    const rawIpfsString = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";
    const ipfsBytes = Buffer.from(rawIpfsString, "utf-8");

    const irPulseSensorCount = 12; // Valid drop registered by ToF sensor

    await program.methods
      .confirmDispense(
        slotZeroIndex,
        Array.from(videoHash),
        Array.from(ipfsBytes),
        irPulseSensorCount
      )
      .accounts({
        machine: machinePda,
        spinSession: spinSessionPda,
        bottleSlot: bottleSlotPda,
        escrowVault: escrowVaultPda,
        treasuryTokenAccount: treasuryAta,
        keeper: keeperAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([keeperAuthority])
      .rpc();

    // Verify Session State
    const sessionAccount = await program.account.spinSession.fetch(spinSessionPda);
    expect(sessionAccount.status).to.deep.equal({ dispensedSuccessfully: {} });
    expect(Buffer.from(sessionAccount.videoHash).toString("hex")).to.equal(videoHash.toString("hex"));

    // Verify Inventory Depletion
    const slotAccount = await program.account.bottleSlot.fetch(bottleSlotPda);
    expect(slotAccount.isAvailable).to.be.false;

    // Verify Treasury Received Funds from Escrow
    const treasuryBal = (await getAccount(provider.connection, treasuryAta)).amount;
    expect(Number(treasuryBal)).to.equal(50_000_000);
  });

  it("5. Rejects unauthorized keeper trying to confirm dispense", async () => {
    const maliciousKeeper = anchor.web3.Keypair.generate();
    const sessionCounter = new anchor.BN(0);

    const [spinSessionPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("session"), machinePda.toBuffer(), sessionCounter.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [bottleSlotPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("bottle"), machinePda.toBuffer(), Buffer.from([slotZeroIndex])],
      program.programId
    );

    try {
      await program.methods
        .confirmDispense(slotZeroIndex, Array(32).fill(0), Array(46).fill(0), 10)
        .accounts({
          machine: machinePda,
          spinSession: spinSessionPda,
          bottleSlot: bottleSlotPda,
          escrowVault: escrowVaultPda,
          treasuryTokenAccount: treasuryAta,
          keeper: maliciousKeeper.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([maliciousKeeper])
        .rpc();
      assert.fail("Should have thrown UnauthorizedKeeper");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedKeeper");
    }
  });
});