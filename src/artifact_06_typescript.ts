import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusTelespin } from "../target/types/baxus_telespin";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("BAXUS TeleSpin Vending Machine Integration Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusTelespin as Program<BaxusTelespin>;

  const authority = Keypair.generate();
  const hardwareSigner = Keypair.generate();
  const creatorUser = Keypair.generate();

  let usdcMint: PublicKey;
  let creatorTokenAccount: PublicKey;
  let machinePda: PublicKey;
  let tierConfigPda: PublicKey;
  let feeVaultPda: PublicKey;

  const machineId = "NYC-FLIP-LOUNGE-01";
  const spinFee = new anchor.BN(50_000_000); // 50 USDC (6 decimals)

  // 10,000 basis points breakdown
  const grailWeight = 100;   // 1% Grail
  const topWeight = 900;     // 9% Top Shelf
  const midWeight = 3000;    // 30% Mid Shelf
  const baseWeight = 6000;   // 60% Vault Sample

  before(async () => {
    // Fund test wallets
    const airdropSignatures = await Promise.all([
      provider.connection.requestAirdrop(authority.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(hardwareSigner.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(creatorUser.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL),
    ]);

    for (const sig of airdropSignatures) {
      await provider.connection.confirmTransaction(sig);
    }

    // Create Mock USDC Mint
    usdcMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Create Creator Token Account and mint 500 USDC
    creatorTokenAccount = await createAccount(
      provider.connection,
      creatorUser,
      usdcMint,
      creatorUser.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      usdcMint,
      creatorTokenAccount,
      authority.publicKey,
      500_000_000
    );

    [machinePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("machine"), Buffer.from(machineId)],
      program.programId
    );

    [tierConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tiers"), machinePda.toBuffer()],
      program.programId
    );

    [feeVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), machinePda.toBuffer()],
      program.programId
    );
  });

  it("Initializes the physical BAXUS vending machine with weights", async () => {
    await program.methods
      .initializeMachine(
        machineId,
        spinFee,
        grailWeight,
        topWeight,
        midWeight,
        baseWeight
      )
      .accounts({
        authority: authority.publicKey,
        hardwareSigner: hardwareSigner.publicKey,
        paymentMint: usdcMint,
        machine: machinePda,
        tierConfig: tierConfigPda,
        feeVault: feeVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const machineAccount = await program.account.machineState.fetch(machinePda);
    expect(machineAccount.machineId).to.equal(machineId);
    expect(machineAccount.spinFeeAmount.toNumber()).to.equal(spinFee.toNumber());
    expect(machineAccount.totalSpins.toNumber()).to.equal(0);
    expect(machineAccount.active).to.be.true;

    const tierAccount = await program.account.tierConfig.fetch(tierConfigPda);
    expect(tierAccount.grailWeight).to.equal(100);
    expect(tierAccount.baseWeight).to.equal(6000);
  });

  it("Executes request_spin: deposits USDC and initializes SpinReceipt", async () => {
    const spinIndex = new anchor.BN(0);
    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), machinePda.toBuffer(), spinIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .requestSpin()
      .accounts({
        user: creatorUser.publicKey,
        machine: machinePda,
        feeVault: feeVaultPda,
        userTokenAccount: creatorTokenAccount,
        spinReceipt: receiptPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([creatorUser])
      .rpc();

    const receipt = await program.account.spinReceipt.fetch(receiptPda);
    expect(receipt.user.toBase58()).to.equal(creatorUser.publicKey.toBase58());
    expect(receipt.spinIndex.toNumber()).to.equal(0);
    expect(receipt.status).to.deep.equal({ initiated: {} });

    // Validate fee vault received USDC
    const vaultBal = await getAccount(provider.connection, feeVaultPda);
    expect(Number(vaultBal.amount)).to.equal(50_000_000);
  });

  it("Settles spin with VRF randomness and determines prize tier", async () => {
    const spinIndex = new anchor.BN(0);
    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), machinePda.toBuffer(), spinIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Mock verifiable random buffer: Choose seed yielding roll < 100 (Grail)
    // 50 % 10000 = 50 -> Grail
    const randomSeed = new Uint8Array(32);
    const roll50 = Buffer.alloc(8);
    roll50.writeBigUInt64LE(BigInt(50));
    randomSeed.set(roll50, 0);

    await program.methods
      .settleSpinVrf(Array.from(randomSeed))
      .accounts({
        authority: authority.publicKey,
        machine: machinePda,
        tierConfig: tierConfigPda,
        spinReceipt: receiptPda,
      })
      .signers([authority])
      .rpc();

    const receipt = await program.account.spinReceipt.fetch(receiptPda);
    expect(receipt.status).to.deep.equal({ resolved: {} });
    expect(receipt.prizeTier).to.deep.equal({ grailWhiskey: {} });
    expect(receipt.assignedCompartment).to.equal(1);
  });

  it("Physical IoT hardware confirms bottle dispense via drop sensor attestation", async () => {
    const spinIndex = new anchor.BN(0);
    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), machinePda.toBuffer(), spinIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const hardwareDropNonce = new anchor.BN(987654321);

    await program.methods
      .confirmPhysicalDispense(hardwareDropNonce)
      .accounts({
        hardwareSigner: hardwareSigner.publicKey,
        machine: machinePda,
        spinReceipt: receiptPda,
      })
      .signers([hardwareSigner])
      .rpc();

    const receipt = await program.account.spinReceipt.fetch(receiptPda);
    expect(receipt.status).to.deep.equal({ dispensed: {} });
    expect(receipt.dispensedAt.toNumber()).to.be.greaterThan(0);
  });

  it("Creator attaches 4K spin video telemetry with Arweave CID and SHA256 hash", async () => {
    const spinIndex = new anchor.BN(0);
    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), machinePda.toBuffer(), spinIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const videoUri = "https://arweave.net/Xw3r9_BAXUS_GRAIL_SPIN_PAPPY_4K.mp4";
    const sampleVideoData = Buffer.from("BAXUS_RAW_VIDEO_STREAM_TEST_CONTENT_FRAME_001");
    const videoSha256 = crypto.createHash("sha256").update(sampleVideoData).digest();

    await program.methods
      .attachCreatorTelemetry(videoUri, Array.from(videoSha256))
      .accounts({
        creator: creatorUser.publicKey,
        spinReceipt: receiptPda,
        machine: machinePda,
      })
      .signers([creatorUser])
      .rpc();

    const receipt = await program.account.spinReceipt.fetch(receiptPda);
    expect(receipt.videoUri).to.equal(videoUri);
    expect(Buffer.from(receipt.videoSha256).toString("hex")).to.equal(videoSha256.toString("hex"));
  });

  it("Rejects non-hardware signer when confirming dispense (Security Guard)", async () => {
    const impostor = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(impostor.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL)
    );

    const spinIndex = new anchor.BN(0);
    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), machinePda.toBuffer(), spinIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .confirmPhysicalDispense(new anchor.BN(12345))
        .accounts({
          hardwareSigner: impostor.publicKey,
          machine: machinePda,
          spinReceipt: receiptPda,
        })
        .signers([impostor])
        .rpc();
      expect.fail("Should have failed with UnauthorizedHardwareSigner");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedHardwareSigner");
    }
  });
});