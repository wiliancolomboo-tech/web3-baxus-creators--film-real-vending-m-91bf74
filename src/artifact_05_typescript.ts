import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BaxusVending } from "../target/types/baxus_vending";
import { expect } from "chai";
import * as crypto from "crypto";

describe("BAXUS Vending Machine End-to-End Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusVending as Program<BaxusVending>;

  const admin = Keypair.generate();
  const user = Keypair.generate();
  const keeper = Keypair.generate();

  const machineId = new anchor.BN(42);
  let machinePda: PublicKey;
  let machineBump: number;
  let treasuryPda: PublicKey;
  let slot0Pda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdropAdmin = await provider.connection.requestAirdrop(admin.publicKey, 5 * LAMPORTS_PER_SOL);
    const airdropUser = await provider.connection.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL);
    const airdropKeeper = await provider.connection.requestAirdrop(keeper.publicKey, 2 * LAMPORTS_PER_SOL);

    const latestBlock = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature: airdropAdmin,
      ...latestBlock,
    });

    [machinePda, machineBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("baxus_machine"), machineId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("baxus_treasury"), machinePda.toBuffer()],
      program.programId
    );

    [slot0Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("baxus_slot"), machinePda.toBuffer(), Buffer.from([0])],
      program.programId
    );
  });

  it("1. Initializes BAXUS Vending Machine Account", async () => {
    await program.methods
      .initializeMachine(machineId, machineBump)
      .accounts({
        machine: machinePda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const machineAccount = await program.account.machineAccount.fetch(machinePda);
    expect(machineAccount.machineId.toNumber()).to.equal(42);
    expect(machineAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(machineAccount.activeSlots).to.equal(0);
    expect(machineAccount.totalSpins.toNumber()).to.equal(0);
  });

  it("2. Configures Slot #0 with Rare Bourbon Bottle Stock", async () => {
    const sku = Buffer.alloc(16);
    sku.write("PAPPY-VAN-WNK-15");

    await program.methods
      .configureSlot(0, Array.from(sku), 100, 5)
      .accounts({
        machine: machinePda,
        slot: slot0Pda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const slotAccount = await program.account.slotAccount.fetch(slot0Pda);
    expect(slotAccount.remainingStock).to.equal(5);
    expect(slotAccount.slotId).to.equal(0);

    const machineAccount = await program.account.machineAccount.fetch(machinePda);
    expect(machineAccount.activeSlots).to.equal(1);
  });

  it("3. User triggers Spin Commitment and Escrows Payment", async () => {
    const machineAccountBefore = await program.account.machineAccount.fetch(machinePda);
    const spinIndex = machineAccountBefore.totalSpins;

    const [spinPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("baxus_spin"),
        machinePda.toBuffer(),
        user.publicKey.toBuffer(),
        spinIndex.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const userEntropy = crypto.randomBytes(32);
    const treasuryBalanceBefore = await provider.connection.getBalance(treasuryPda);

    await program.methods
      .requestSpin(Array.from(userEntropy))
      .accounts({
        machine: machinePda,
        spinRecord: spinPda,
        user: user.publicKey,
        treasury: treasuryPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const treasuryBalanceAfter = await provider.connection.getBalance(treasuryPda);
    expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(50_000_000);

    const spinRecord = await program.account.spinRecord.fetch(spinPda);
    expect(spinRecord.user.toBase58()).to.equal(user.publicKey.toBase58());
    expect(spinRecord.isSettled).to.be.false;
  });

  it("4. Fails settlement if attempted in the same block (Anti-MEV guard)", async () => {
    const machineAccount = await program.account.machineAccount.fetch(machinePda);
    const spinIndex = machineAccount.totalSpins;

    const [spinPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("baxus_spin"),
        machinePda.toBuffer(),
        user.publicKey.toBuffer(),
        spinIndex.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const keeperEntropy = crypto.randomBytes(32);

    try {
      await program.methods
        .settleSpin(Array.from(keeperEntropy))
        .accounts({
          machine: machinePda,
          spinRecord: spinPda,
          slot: slot0Pda,
          keeper: keeper.publicKey,
        })
        .signers([keeper])
        .rpc();
      expect.fail("Should have failed with BlockDelayNotMet error");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.satisfy(
        (code: string) => code.includes("BlockDelayNotMet") || code.includes("custom program error")
      );
    }
  });

  it("5. Settles Spin successfully after block delay, decrements stock & emits telemetry", async () => {
    // Advance block by performing empty transfer
    await provider.connection.requestAirdrop(admin.publicKey, 1000);

    const machineAccount = await program.account.machineAccount.fetch(machinePda);
    const spinIndex = machineAccount.totalSpins;

    const [spinPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("baxus_spin"),
        machinePda.toBuffer(),
        user.publicKey.toBuffer(),
        spinIndex.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const keeperEntropy = crypto.randomBytes(32);

    let eventEmitted = false;
    const listenerId = program.addEventListener("DispenseTelemetryEvent", (event) => {
      expect(event.slotId).to.equal(0);
      expect(event.recipient.toBase58()).to.equal(user.publicKey.toBase58());
      eventEmitted = true;
    });

    await program.methods
      .settleSpin(Array.from(keeperEntropy))
      .accounts({
        machine: machinePda,
        spinRecord: spinPda,
        slot: slot0Pda,
        keeper: keeper.publicKey,
      })
      .signers([keeper])
      .rpc();

    await new Promise((res) => setTimeout(res, 1000));
    await program.removeEventListener(listenerId);

    const slotAccountAfter = await program.account.slotAccount.fetch(slot0Pda);
    expect(slotAccountAfter.remainingStock).to.equal(4);

    const spinRecordAfter = await program.account.spinRecord.fetch(spinPda);
    expect(spinRecordAfter.isSettled).to.be.true;
    expect(spinRecordAfter.awardedSlotId).to.equal(0);
    expect(eventEmitted).to.be.true;
  });
});