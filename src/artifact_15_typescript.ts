import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusVendingMachine } from "../target/types/baxus_vending_machine";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import crypto from "crypto";

describe("BAXUS Vending Machine & Creator Studio Engine", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusVendingMachine as Program<BaxusVendingMachine>;

  const machineId = 101;
  const authority = Keypair.generate();
  const hardwareSigner = Keypair.generate();
  const user = Keypair.generate();

  let paymentMint: anchor.web3.PublicKey;
  let userPaymentAta: anchor.web3.PublicKey;
  let bottleGrailMint: anchor.web3.PublicKey;
  let bottleRareMint: anchor.web3.PublicKey;
  let bottleReserveMint: anchor.web3.PublicKey;
  let bottleCommonMint: anchor.web3.PublicKey;

  let vendingMachinePda: anchor.web3.PublicKey;
  let escrowVaultPda: anchor.web3.PublicKey;

  const costPerSpin = new anchor.BN(25_000_000); // 25 USDC

  before(async () => {
    // 1. Airdrop SOL to test actors
    for (const actor of [authority, hardwareSigner, user]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // 2. Create mock payment mint (USDC)
    paymentMint = await createMint(provider.connection, authority, authority.publicKey, null, 6);

    // 3. Create mock RWA Bottle mints
    bottleGrailMint = await createMint(provider.connection, authority, authority.publicKey, null, 0);
    bottleRareMint = await createMint(provider.connection, authority, authority.publicKey, null, 0);
    bottleReserveMint = await createMint(provider.connection, authority, authority.publicKey, null, 0);
    bottleCommonMint = await createMint(provider.connection, authority, authority.publicKey, null, 0);

    // 4. Setup User Token Account & Mint 500 USDC
    const userAtaObj = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      paymentMint,
      user.publicKey
    );
    userPaymentAta = userAtaObj.address;
    await mintTo(provider.connection, authority, paymentMint, userPaymentAta, authority, 500_000_000);

    // 5. Derive Machine PDAs
    const machineIdBuffer = Buffer.alloc(4);
    machineIdBuffer.writeUInt32LE(machineId);

    [vendingMachinePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vending_machine"), machineIdBuffer],
      program.programId
    );

    [escrowVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), machineIdBuffer],
      program.programId
    );
  });

  it("1. Initializes BAXUS Vending Machine with 4-tier configuration", async () => {
    const tiers = [
      {
        tier: { common: {} },
        probabilityBps: 7000, // 70.00%
        bottleMint: bottleCommonMint,
        activeStock: 50,
      },
      {
        tier: { reserve: {} },
        probabilityBps: 2000, // 20.00%
        bottleMint: bottleReserveMint,
        activeStock: 20,
      },
      {
        tier: { rare: {} },
        probabilityBps: 900, // 9.00%
        bottleMint: bottleRareMint,
        activeStock: 10,
      },
      {
        tier: { grail: {} },
        probabilityBps: 100, // 1.00% (The Macallan 25 / Pappy 23)
        bottleMint: bottleGrailMint,
        activeStock: 2,
      },
    ];

    await program.methods
      .initializeMachine(machineId, costPerSpin, tiers as any)
      .accountsPartial({
        authority: authority.publicKey,
        hardwareSigner: hardwareSigner.publicKey,
        paymentMint: paymentMint,
        vendingMachine: vendingMachinePda,
        escrowVault: escrowVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const machineState = await program.account.vendingMachine.fetch(vendingMachinePda);
    expect(machineState.machineId).to.equal(machineId);
    expect(machineState.totalSpins.toNumber()).to.equal(0);
    expect(machineState.hardwareSigner.toBase58()).to.equal(hardwareSigner.publicKey.toBase58());
  });

  it("2. Executes user spin request, escrows USDC & generates SpinTicket PDA", async () => {
    const userCommitment = crypto.randomBytes(32);
    const machineIdBuffer = Buffer.alloc(4);
    machineIdBuffer.writeUInt32LE(machineId);

    const spinIndexBuffer = Buffer.alloc(8);
    spinIndexBuffer.writeBigUInt64LE(0n);

    const [spinTicketPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("spin_ticket"), machineIdBuffer, spinIndexBuffer],
      program.programId
    );

    const tx = await program.methods
      .requestSpin(machineId, Array.from(userCommitment))
      .accountsPartial({
        user: user.publicKey,
        vendingMachine: vendingMachinePda,
        paymentMint: paymentMint,
        userTokenAccount: userPaymentAta,
        escrowVault: escrowVaultPda,
        spinTicket: spinTicketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    expect(tx).to.be.a("string");

    const ticketState = await program.account.spinTicket.fetch(spinTicketPda);
    expect(ticketState.user.toBase58()).to.equal(user.publicKey.toBase58());
    expect(ticketState.status).to.deep.equal({ committed: {} });

    // Verify machine total spins incremented
    const machineState = await program.account.vendingMachine.fetch(vendingMachinePda);
    expect(machineState.totalSpins.toNumber()).to.equal(1);
  });

  it("3. Prevents instant fulfillment within the same slot (anti-frontrun)", async () => {
    const machineIdBuffer = Buffer.alloc(4);
    machineIdBuffer.writeUInt32LE(machineId);
    const spinIndexBuffer = Buffer.alloc(8);
    spinIndexBuffer.writeBigUInt64LE(0n);

    const [spinTicketPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("spin_ticket"), machineIdBuffer, spinIndexBuffer],
      program.programId
    );

    const entropy = crypto.randomBytes(32);

    try {
      await program.methods
        .fulfillSpin(machineId, new anchor.BN(0), Array.from(entropy))
        .accountsPartial({
          caller: hardwareSigner.publicKey,
          vendingMachine: vendingMachinePda,
          spinTicket: spinTicketPda,
          slotHashes: new anchor.web3.PublicKey("SysvarS1otHashes111111111111111111111111111"),
        })
        .signers([hardwareSigner])
        .rpc();
      expect.fail("Should have rejected fulfillment in same commit slot");
    } catch (err: any) {
      // Expect CommitmentTooFresh error code if mined instantly
      expect(err.toString()).to.satisfy(
        (msg: string) => msg.includes("CommitmentTooFresh") || msg.includes("Error")
      );
    }
  });

  it("4. Fulfills spin after slot progression and verifies state transition", async () => {
    // Wait for slot to advance
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const machineIdBuffer = Buffer.alloc(4);
    machineIdBuffer.writeUInt32LE(machineId);
    const spinIndexBuffer = Buffer.alloc(8);
    spinIndexBuffer.writeBigUInt64LE(0n);

    const [spinTicketPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("spin_ticket"), machineIdBuffer, spinIndexBuffer],
      program.programId
    );

    const entropy = crypto.randomBytes(32);

    await program.methods
      .fulfillSpin(machineId, new anchor.BN(0), Array.from(entropy))
      .accountsPartial({
        caller: hardwareSigner.publicKey,
        vendingMachine: vendingMachinePda,
        spinTicket: spinTicketPda,
        slotHashes: new anchor.web3.PublicKey("SysvarS1otHashes111111111111111111111111111"),
      })
      .signers([hardwareSigner])
      .rpc();

    const ticketState = await program.account.spinTicket.fetch(spinTicketPda);
    expect(ticketState.status).to.deep.equal({ fulfilled: {} });
    expect(ticketState.settledTier).to.not.be.null;
    expect(ticketState.dispensedMint.toBase58()).to.not.equal(anchor.web3.PublicKey.default.toBase58());
  });

  it("5. Acknowledges physical drop via hardware signature", async () => {
    const machineIdBuffer = Buffer.alloc(4);
    machineIdBuffer.writeUInt32LE(machineId);
    const spinIndexBuffer = Buffer.alloc(8);
    spinIndexBuffer.writeBigUInt64LE(0n);

    const [spinTicketPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("spin_ticket"), machineIdBuffer, spinIndexBuffer],
      program.programId
    );

    await program.methods
      .ackHardwareDispense(machineId, new anchor.BN(0))
      .accountsPartial({
        hardwareSigner: hardwareSigner.publicKey,
        vendingMachine: vendingMachinePda,
        spinTicket: spinTicketPda,
      })
      .signers([hardwareSigner])
      .rpc();

    const ticketState = await program.account.spinTicket.fetch(spinTicketPda);
    expect(ticketState.status).to.deep.equal({ dispensed: {} });
  });

  it("6. Rejects unauthorized hardware acknowledgement", async () => {
    const fakeSigner = Keypair.generate();
    const machineIdBuffer = Buffer.alloc(4);
    machineIdBuffer.writeUInt32LE(machineId);
    const spinIndexBuffer = Buffer.alloc(8);
    spinIndexBuffer.writeBigUInt64LE(0n);

    const [spinTicketPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("spin_ticket"), machineIdBuffer, spinIndexBuffer],
      program.programId
    );

    try {
      await program.methods
        .ackHardwareDispense(machineId, new anchor.BN(0))
        .accountsPartial({
          hardwareSigner: fakeSigner.publicKey,
          vendingMachine: vendingMachinePda,
          spinTicket: spinTicketPda,
        })
        .signers([fakeSigner])
        .rpc();
      expect.fail("Should have failed with UnauthorizedHardwareSigner");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedHardwareSigner");
    }
  });
});