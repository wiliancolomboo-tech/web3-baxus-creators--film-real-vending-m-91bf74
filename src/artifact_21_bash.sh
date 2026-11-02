ts-node -e '
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = JSON.parse(require("fs").readFileSync("./target/idl/baxus_vending_machine.json", "utf8"));
  const program = new anchor.Program(idl, provider);

  const machineId = 1;
  const hardwarePubkey = new PublicKey("HWrDkEp9u7sZ798ZqXW8jB4uL9kP1U8R9Y3M2N1B4V7");
  const usdcDevnet = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

  const [machinePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("machine"), new anchor.BN(machineId).toArrayLike(Buffer, "le", 4)],
    program.programId
  );

  const tx = await program.methods
    .initializeMachine(machineId, new anchor.BN(120), hardwarePubkey)
    .accounts({
      machineConfig: machinePda,
      paymentMint: usdcDevnet,
      authority: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Machine Initialized. Signature:", tx);
}
main();
'