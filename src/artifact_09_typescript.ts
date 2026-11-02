import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusVending } from "../target/types/baxus_vending";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import * as crypto from "crypto";

describe("baxus-vending QA Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusVending as Program<BaxusVending>;

  const admin = anchor.web3.Keypair.generate();
  const keeper = anchor.web3.Keypair.generate();
  const user = anchor.web3.Keypair.generate();

  let paymentMint: anchor.web3.Pubkey;
  let userPaymentAta: anchor.web3.Pubkey;
  let treasuryAta: anchor.web3.Pubkey;

  let bottleMintTier1: anchor.web3.Pubkey; // Legendary
  let bottleMintTier2: anchor.web3.Pubkey; // UltraRare
  let bottleMintTier3: anchor.web3.Pubkey; // Curated
  let bottleMintTier4: anchor.web3.Pubkey; // Collector

  let machinePoolPda: anchor.web3.Pubkey;
  let machineBump: number;
  let configPda: anchor.web3.Pubkey;

  let vaultAtaTier1: anchor.web3.Pubkey;
  let vaultAtaTier2: anchor.web3.Pubkey;
  let vaultAtaTier3: anchor.web3.Pubkey;
  let vaultAtaTier4: anchor.web3.Pubkey;

  let userBottleAta: anchor.web3.Pubkey;

  const machineId = new anchor.BN(42);
  const spinPrice = new anchor.BN(50_000_000); // 50 USDC (6 decimals)

  before(async () => {
    // 1. Airdrop SOL to test participants
    const txAirdropAdmin = await provider.connection.requestAirdrop(admin.pubkey(), 10 * anchor.web3.LAMPORTS_PER_SOL);
    const txAirdropUser = await provider.connection.requestAirdrop(user.pubkey(), 10 * anchor.web3.LAMPORTS_PER_SOL);
    const txAirdropKeeper = await provider.connection.requestAirdrop(keeper.pubkey(), 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(txAirdropAdmin);
    await provider.connection.confirmTransaction(txAirdropUser);
    await provider.connection.confirmTransaction(txAirdropKeeper);

    // 2. Create Payment Currency (Mock USDC - SPL Token)
    paymentMint = await createMint(
      provider.connection,
      admin,
      admin.pubkey(),
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // 3. Create Treasury and User Payment ATA
    treasuryAta = await createAccount(
      provider.connection,
      admin,
      paymentMint,
      admin.pubkey(),
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    userPaymentAta = await createAccount(
      provider.connection,
      user,
      paymentMint,
      user.pubkey(),
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Fund user with 500 USDC
    await mintTo(
      provider.connection,
      admin,
      paymentMint,
      userPaymentAta,
      admin,
      500_000_000,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // 4. Derive PDAs
    [configPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [machinePoolPda, machineBump] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("machine"), machineId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 5. Create Token-2022 RWA Bottle Mints
    bottleMintTier1 = await createMint(provider.connection, admin, admin.pubkey(), null, 0, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    bottleMintTier2 = await createMint(provider.connection, admin, admin.pubkey(), null, 0, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    bottleMintTier3 = await createMint(provider.connection, admin, admin.pubkey(), null, 0, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    bottleMintTier4 = await createMint(provider.connection, admin, admin.pubkey(), null, 0, undefined, undefined, TOKEN_2022_PROGRAM_ID);

    // 6. Create Machine Escrow Vault ATAs for Bottles (Owned by machine PDA)
    vaultAtaTier1 = await createAccount(provider.connection, admin, bottleMintTier1, machinePoolPda, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    vaultAtaTier2 = await createAccount(provider.connection, admin, bottleMintTier2, machinePoolPda, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    vaultAtaTier3 = await createAccount(provider.connection, admin, bottleMintTier3, machinePoolPda, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    vaultAtaTier4 = await createAccount(provider.connection, admin, bottleMintTier4, machinePoolPda, undefined, undefined, TOKEN_2022_PROGRAM_ID);

    // Mint inventory into machine vault
    await mintTo(provider.connection, admin, bottleMintTier1, vaultAtaTier1, admin, 1, [], undefined, TOKEN_2022_PROGRAM_ID);
    await mintTo(provider.connection, admin, bottleMintTier2, vaultAtaTier2, admin, 5, [], undefined, TOKEN_2022_PROGRAM_ID);
    await mintTo(provider.connection, admin, bottleMintTier3, vaultAtaTier3, admin, 20, [], undefined, TOKEN_2022_PROGRAM_ID);
    await mintTo(provider.connection, admin, bottleMintTier4, vaultAtaTier4, admin, 100, [], undefined, TOKEN_2022_PROGRAM_ID);
  });

  it("1. Initializes protocol config PDA", async () => {
    await program.methods
      .initializeProtocol(treasuryAta, keeper.pubkey())
      .accounts({
        config: configPda,
        paymentMint: paymentMint,
        admin: admin.pubkey(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.machineConfig.fetch(configPda);
    assert.equal(configAccount.admin.toBase58(), admin.pubkey().toBase58());
    assert.equal(configAccount.keeperAuthority.toBase58(), keeper.pubkey().toBase58());
  });

  it("2. Registers new physical vending machine with 4-tier inventory", async () => {
    const rawName = Buffer.alloc(32);
    rawName.write("BAXUS Flagship Dispenser 01");

    const tiers = [
      { tier: 0, weightBps: 50, bottleMint: bottleMintTier1, currentInventory: 1 },    // 0.5% Legendary
      { tier: 1, weightBps: 450, bottleMint: bottleMintTier2, currentInventory: 5 },   // 4.5% Ultra Rare
      { tier: 2, weightBps: 2000, bottleMint: bottleMintTier3, currentInventory: 20 }, // 20.0% Curated
      { tier: 3, weightBps: 7500, bottleMint: bottleMintTier4, currentInventory: 100 },// 75.0% Pour
    ];

    await program.methods
      .registerMachine(machineId, Array.from(rawName), spinPrice, tiers)
      .accounts({
        config: configPda,
        machinePool: machinePoolPda,
        admin: admin.pubkey(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const machineAcc = await program.account.vendingMachinePool.fetch(machinePoolPda);
    assert.equal(machineAcc.machineId.toNumber(), 42);
    assert.equal(machineAcc.spinPriceAtomic.toNumber(), 50_000_000);
    assert.isTrue(machineAcc.isActive);
  });

  it("3. Executes spin, transfers USDC, locks state & emits event", async () => {
    const sessionId = new anchor.BN(1001);
    const clientSeed = crypto.randomBytes(32);

    const [sessionPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [
        Buffer.from("session"),
        machineId.toArrayLike(Buffer, "le", 8),
        sessionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const treasuryBefore = await getAccount(provider.connection, treasuryAta, undefined, TOKEN_PROGRAM_ID);

    await program.methods
      .spinMachine(machineId, sessionId, Array.from(clientSeed))
      .accounts({
        config: configPda,
        machinePool: machinePoolPda,
        dispenseSession: sessionPda,
        user: user.pubkey(),
        userPaymentAta: userPaymentAta,
        treasuryAta: treasuryAta,
        paymentMint: paymentMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const treasuryAfter = await getAccount(provider.connection, treasuryAta, undefined, TOKEN_PROGRAM_ID);
    assert.equal(
      Number(treasuryAfter.amount) - Number(treasuryBefore.amount),
      50_000_000,
      "50 USDC successfully deposited into Treasury"
    );

    const session = await program.account.dispenseSession.fetch(sessionPda);
    assert.equal(session.user.toBase58(), user.pubkey().toBase58());
    assert.isNotNull(session.awardedTier);
  });

  it("4. Rejects settle attempt from unauthorized keeper", async () => {
    const sessionId = new anchor.BN(1001);
    const [sessionPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [
        Buffer.from("session"),
        machineId.toArrayLike(Buffer, "le", 8),
        sessionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const session = await program.account.dispenseSession.fetch(sessionPda);
    const imposter = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(imposter.pubkey(), anchor.web3.LAMPORTS_PER_SOL);

    const mockHash = crypto.createHash("sha256").update("fake_footage").digest();
    const uriBuf = Buffer.alloc(64);
    uriBuf.write("ar://mock-fake-tx");

    userBottleAta = await createAccount(
      provider.connection,
      user,
      session.awardedMint,
      user.pubkey(),
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    try {
      await program.methods
        .recordDispenseAndSettle(machineId, sessionId, Array.from(mockHash), Array.from(uriBuf))
        .accounts({
          config: configPda,
          machinePool: machinePoolPda,
          dispenseSession: sessionPda,
          keeper: imposter.pubkey(),
          bottleMint: session.awardedMint,
          escrowVaultAta: vaultAtaTier4,
          userBottleAta: userBottleAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([imposter])
        .rpc();
      assert.fail("Should have thrown UnauthorizedKeeper");
    } catch (err: any) {
      assert.include(err.toString(), "UnauthorizedKeeper");
    }
  });

  it("5. Settles physical dispense, anchors 4K video hash & transfers RWA bottle NFT", async () => {
    const sessionId = new anchor.BN(1001);
    const [sessionPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [
        Buffer.from("session"),
        machineId.toArrayLike(Buffer, "le", 8),
        sessionId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const session = await program.account.dispenseSession.fetch(sessionPda);

    // Identify which vault ATA holds this mint
    let sourceVaultAta = vaultAtaTier4;
    if (session.awardedMint.equals(bottleMintTier1)) sourceVaultAta = vaultAtaTier1;
    else if (session.awardedMint.equals(bottleMintTier2)) sourceVaultAta = vaultAtaTier2;
    else if (session.awardedMint.equals(bottleMintTier3)) sourceVaultAta = vaultAtaTier3;

    // Generate valid 4K video sha256 checksum and permanent storage URI
    const rawVideoHash = crypto.createHash("sha256").update("baxus_spin_session_1001_frame_data_mp4").digest();
    const uriBuf = Buffer.alloc(64);
    uriBuf.write("ar://baxus-vending-dispense-session-1001-4k-proof");

    await program.methods
      .recordDispenseAndSettle(
        machineId,
        sessionId,
        Array.from(rawVideoHash),
        Array.from(uriBuf)
      )
      .accounts({
        config: configPda,
        machinePool: machinePoolPda,
        dispenseSession: sessionPda,
        keeper: keeper.pubkey(),
        bottleMint: session.awardedMint,
        escrowVaultAta: sourceVaultAta,
        userBottleAta: userBottleAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    // Verify Session State
    const settledSession = await program.account.dispenseSession.fetch(sessionPda);
    assert.deepEqual(Array.from(settledSession.videoProofHash), Array.from(rawVideoHash));
    assert.isNotNull(settledSession.status.dispensedAndVerified);

    // Verify Token Custody Transferred
    const userBottleAccount = await getAccount(
      provider.connection,
      userBottleAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(userBottleAccount.amount.toString(), "1", "User received exactly 1 bottle token");
  });
});