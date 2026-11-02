import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusVendingMachine } from "../target/types/baxus_vending_machine";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { expect } from "chai";

describe("baxus_vending_machine", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BaxusVendingMachine as Program<BaxusVendingMachine>;

  const machineId = 101;
  const costPerSpin = new anchor.BN(0.25 * LAMPORTS_PER_SOL);
  const hardwareSigner = Keypair.generate();
  const player = Keypair.generate();

  let machinePda: PublicKey;
  let machineBump: number;

  before(async () => {
    // Airdrop SOL to player and hardware signer for tx fees
    const airdropSig1 = await provider.connection.requestAirdrop(player.publicKey, 5 * LAMPORTS_PER_SOL);
    const airdropSig2 = await provider.connection.requestAirdrop(hardwareSigner.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig1);
    await provider.connection.confirmTransaction(airdropSig2);

    const machineIdBuffer = Buffer.alloc(4);
    machineIdBuffer.writeUInt32LE(machineId, 0);

    [machinePda, machineBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("baxus_machine"), machineIdBuffer],
      program.programId
    );
  });

  it("Initializes the BAXUS Vending Machine", async () => {
    await program.methods
      .initializeMachine(machineId, costPerSpin, 4)
      .accounts({
        machine: machinePda,
        hardwareKey: hardwareSigner.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const machineAccount = await program.account.vendingMachine.fetch(machinePda);
    expect(machineAccount.machineId).to.equal(machineId);
    expect(machineAccount.costPerSpinLamports.toString()).to.equal(costPerSpin.toString());
    expect(machineAccount.maxShelves).to.equal(4);
    expect(machineAccount.hardwareKey.toBase58()).to.equal(hardwareSigner.publicKey.toBase58());
  });

  it("Loads inventory of high-value bottles into shelf tiers", async () => {
    // Shelf 0: Standard Artisanal (Tier 0), 20 bottles
    await program.methods
      .loadInventory(0, { standardCraft: {} }, 20)
      .accounts({ machine: machinePda, authority: provider.wallet.publicKey })
      .rpc();

    // Shelf 1: Premium Bourbon (Tier 1), 5 bottles
    await program.methods
      .loadInventory(1, { premiumBourbon: {} }, 5)
      .accounts({ machine: machinePda, authority: provider.wallet.publicKey })
      .rpc();

    // Shelf 2: Ultra Rare Single Cask (Tier 2), 2 bottles
    await program.methods
      .loadInventory(2, { ultraRareWhisky: {} }, 2)
      .accounts({ machine: machinePda, authority: provider.wallet.publicKey })
      .rpc();

    const state = await program.account.vendingMachine.fetch(machinePda);
    expect(state.shelfQuantities[0]).to.equal(20);
    expect(state.shelfQuantities[1]).to.equal(5);
    expect(state.shelfQuantities[2]).to.equal(2);
  });

  it("Executes a Provably Fair Spin Request, Reveal, and Physical Dispense", async () => {
    // 1. Generate user preimage & commitment
    const userPreimage = randomBytes(32);
    const userCommitment = createHash("sha256").update(userPreimage).digest();

    const machineStateBefore = await program.account.vendingMachine.fetch(machinePda);
    const nonce = machineStateBefore.totalSpinsCompleted;
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(BigInt(nonce.toString()), 0);

    const [spinSessionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("baxus_spin"),
        machinePda.toBuffer(),
        player.publicKey.toBuffer(),
        nonceBuffer,
      ],
      program.programId
    );

    // 2. Request Spin
    await program.methods
      .requestSpin(Array.from(userCommitment))
      .accounts({
        machine: machinePda,
        spinSession: spinSessionPda,
        player: player.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([player])
      .rpc();

    let spinSession = await program.account.spinSession.fetch(spinSessionPda);
    expect(spinSession.status).to.deep.equal({ committed: {} });
    expect(spinSession.player.toBase58()).to.equal(player.publicKey.toBase58());

    // 3. Resolve Spin (Operator Reveal)
    const operatorSeed = randomBytes(32);
    await program.methods
      .resolveSpin(Array.from(operatorSeed), Array.from(userPreimage))
      .accounts({
        machine: machinePda,
        spinSession: spinSessionPda,
        authority: provider.wallet.publicKey,
        recentBlockhashes: anchor.web3.SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
      })
      .rpc();

    spinSession = await program.account.spinSession.fetch(spinSessionPda);
    expect(spinSession.status).to.deep.equal({ resolvedWaitingDispense: {} });
    const chosenShelf = spinSession.allocatedShelf;

    // 4. Confirm Mechanical Dispense via IoT hardware signer
    const dummySignature = new Array(64).fill(1);
    await program.methods
      .confirmPhysicalDispense(dummySignature)
      .accounts({
        machine: machinePda,
        spinSession: spinSessionPda,
        hardwareKey: hardwareSigner.publicKey,
      })
      .signers([hardwareSigner])
      .rpc();

    spinSession = await program.account.spinSession.fetch(spinSessionPda);
    expect(spinSession.status).to.deep.equal({ dispensed: {} });

    const machineStateAfter = await program.account.vendingMachine.fetch(machinePda);
    expect(machineStateAfter.totalSpinsCompleted.toNumber()).to.equal(nonce.toNumber() + 1);
  });
});