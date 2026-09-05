import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusVending } from "../target/types/baxus_vending";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { createHash, randomBytes } from "crypto";

describe("BAXUS Vending System: Provable Spins & Dispense", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusVending as Program<BaxusVending>;

  const admin = Keypair.generate();
  const hardwareSigner = Keypair.generate();
  const user = Keypair.generate();

  let paymentMint: PublicKey;
  let userTokenAccount: PublicKey;
  let machineStatePda: PublicKey;
  let escrowVaultPda: PublicKey;

  const machineIdRaw = "BAXUS_NYC_VEND01";
  const machineId = Array.from(Buffer.from(machineIdRaw.padEnd(16, "\0")));
  const spinPrice = new anchor.BN(25_000_000); // 25 USDC (6 decimals)

  before(async () => {
    // Fund actors
    for (const actor of [admin, hardwareSigner, user]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize USDC mock mint
    paymentMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Setup user token account and mint 200 USDC
    userTokenAccount = await createAccount(
      provider.connection,
      user,
      paymentMint,
      user.publicKey
    );
    await mintTo(provider.connection, admin, paymentMint, userTokenAccount, admin, 200_000_000);

    // Derive PDAs
    [machineStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("machine"), Buffer.from(machineId)],
      program.programId
    );

    [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), Buffer.from(machineId)],
      program.programId
    );
  });

  it("Initializes the Physical Machine Profile", async () => {
    await program.methods
      .initializeMachine(machineId, spinPrice, new anchor.BN(60))
      .accounts({
        admin: admin.publicKey,
        hardwareSigner: hardwareSigner.publicKey,
        paymentMint: paymentMint,
        machineState: machineStatePda,
        escrowVault: escrowVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const machineState = await program.account.machineState.fetch(machineStatePda);
    expect(machineState.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(machineState.hardwareSigner.toBase58()).to.equal(hardwareSigner.publicKey.toBase58());
    expect(machineState.pricePerSpin.toNumber()).to.equal(25_000_000);
  });

  it("Stocks Physical Slots with Tiered Bottles", async () => {
    // Slot 0: Pappy Van Winkle 23yr (Tier 1: Rare - 500 bps = 5%)
    // Slot 1: Blanton's Gold Edition (Tier 2: Premium - 2500 bps = 25%)
    // Slot 2: WhistlePig 10yr Mini (Tier 3: Common - 7000 bps = 70%)

    const slotsConfig = [
      { slotId: 0, qty: 1, weight: 500, tier: 1 },
      { slotId: 1, qty: 5, weight: 2500, tier: 2 },
      { slotId: 2, qty: 20, weight: 7000, tier: 3 },
    ];

    for (const cfg of slotsConfig) {
      const [slotPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("inventory"), machineStatePda.toBuffer(), Buffer.from([cfg.slotId])],
        program.programId
      );

      const rwaId = randomBytes(32);

      await program.methods
        .stockInventorySlot(cfg.slotId, cfg.qty, cfg.weight, Array.from(rwaId), cfg.tier)
        .accounts({
          machineState: machineStatePda,
          admin: admin.publicKey,
          inventorySlot: slotPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const slotData = await program.account.inventorySlot.fetch(slotPda);
      expect(slotData.remainingStock).to.equal(cfg.qty);
      expect(slotData.weightBps).to.equal(cfg.weight);
    }
  });

  it("Executes Complete 3-Phase Physical Spin: Commit -> Settle -> Dispense", async () => {
    // Phase 1: User generates secret, hashes it, commits
    const secret = randomBytes(32);
    const commitment = createHash("sha256").update(secret).digest();

    const machineBefore = await program.account.machineState.fetch(machineStatePda);
    const spinIndex = machineBefore.totalSpins;

    const [spinTicketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spin"), machineStatePda.toBuffer(), spinIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .commitSpin(Array.from(commitment))
      .accounts({
        user: user.publicKey,
        machineState: machineStatePda,
        escrowVault: escrowVaultPda,
        userTokenAccount: userTokenAccount,
        spinTicket: spinTicketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    let ticket = await program.account.spinTicket.fetch(spinTicketPda);
    expect(ticket.status).to.deep.equal({ committed: {} });

    // Wait 1 slot to satisfy `clock.slot > spin_ticket.committed_slot`
    await new Promise((r) => setTimeout(r, 1000));

    // Phase 2: Settle spin with reveal secret
    const slot0Pda = PublicKey.findProgramAddressSync(
      [Buffer.from("inventory"), machineStatePda.toBuffer(), Buffer.from([0])],
      program.programId
    )[0];
    const slot1Pda = PublicKey.findProgramAddressSync(
      [Buffer.from("inventory"), machineStatePda.toBuffer(), Buffer.from([1])],
      program.programId
    )[0];
    const slot2Pda = PublicKey.findProgramAddressSync(
      [Buffer.from("inventory"), machineStatePda.toBuffer(), Buffer.from([2])],
      program.programId
    )[0];

    await program.methods
      .settleSpin(Array.from(secret))
      .accounts({
        user: user.publicKey,
        machineState: machineStatePda,
        spinTicket: spinTicketPda,
        recentSlothashes: SYSVAR_SLOT_HASHES_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: slot0Pda, isWritable: true, isSigner: false },
        { pubkey: slot1Pda, isWritable: true, isSigner: false },
        { pubkey: slot2Pda, isWritable: true, isSigner: false },
      ])
      .signers([user])
      .rpc();

    ticket = await program.account.spinTicket.fetch(spinTicketPda);
    expect(ticket.status).to.deep.equal({ settledAwaitingDispense: {} });
    console.log(`[TEST RESULT] Provably settled winning slot: ${ticket.wonSlot}`);

    // Phase 3: Physical machine hardware confirms optical drop
    const mockTelemetryProof = randomBytes(32);
    await program.methods
      .confirmDispense(Array.from(mockTelemetryProof))
      .accounts({
        hardwareSigner: hardwareSigner.publicKey,
        machineState: machineStatePda,
        spinTicket: spinTicketPda,
      })
      .signers([hardwareSigner])
      .rpc();

    ticket = await program.account.spinTicket.fetch(spinTicketPda);
    expect(ticket.status).to.deep.equal({ dispensedSuccessfully: {} });
  });

  it("Rejects Unauthorized Hardware Confirmation", async () => {
    const maliciousImposter = Keypair.generate();
    await provider.connection.requestAirdrop(maliciousImposter.publicKey, anchor.web3.LAMPORTS_PER_SOL);

    const secret = randomBytes(32);
    const commitment = createHash("sha256").update(secret).digest();
    const machine = await program.account.machineState.fetch(machineStatePda);
    const spinIndex = machine.totalSpins;

    const [spinTicketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spin"), machineStatePda.toBuffer(), spinIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Commit
    await program.methods
      .commitSpin(Array.from(commitment))
      .accounts({
        user: user.publicKey,
        machineState: machineStatePda,
        escrowVault: escrowVaultPda,
        userTokenAccount: userTokenAccount,
        spinTicket: spinTicketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    await new Promise((r) => setTimeout(r, 1000));

    // Settle
    const slot2Pda = PublicKey.findProgramAddressSync(
      [Buffer.from("inventory"), machineStatePda.toBuffer(), Buffer.from([2])],
      program.programId
    )[0];

    await program.methods
      .settleSpin(Array.from(secret))
      .accounts({
        user: user.publicKey,
        machineState: machineStatePda,
        spinTicket: spinTicketPda,
        recentSlothashes: SYSVAR_SLOT_HASHES_PUBKEY,
      })
      .remainingAccounts([{ pubkey: slot2Pda, isWritable: true, isSigner: false }])
      .signers([user])
      .rpc();

    // Imposter attempts to sign hardware confirmation
    try {
      await program.methods
        .confirmDispense(Array.from(randomBytes(32)))
        .accounts({
          hardwareSigner: maliciousImposter.publicKey,
          machineState: machineStatePda,
          spinTicket: spinTicketPda,
        })
        .signers([maliciousImposter])
        .rpc();
      expect.fail("Should have failed with UnauthorizedHardware");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedHardware");
    }
  });
});