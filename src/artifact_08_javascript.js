// scripts/hardware_test_000000000000000000000000.js
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
const idl = require("../target/idl/baxus_vending.json");

async function startDaemon(machineId, rpcUrl, hardwareKeypair) {
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(hardwareKeypair);
  const provider = new AnchorProvider(connection, wallet, {});
  const program = new Program(idl, idl.metadata.address, provider);

  console.log(`[BAXUS HW] Listening for Dispense Tickets on Machine: ${machineId}`);

  program.addEventListener("SpinSettledEvent", async (event, slot) => {
    if (event.machineId.toString() === machineId.toString()) {
      console.log(`[BAXUS HW] Event Received: Tier ${event.wonTier} won by ${event.user.toBase58()}`);
      console.log(`[BAXUS HW] Actuating Solenoid / Dispenser Servo...`);
      
      // Simulate hardware drop confirmation
      setTimeout(async () => {
        console.log(`[BAXUS HW] Physical bottle confirmed dropped. Signing dispense claim.`);
        // Invokes claim_physical_dispense on-chain...
      }, 3000);
    }
  });
}