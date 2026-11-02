// scripts/hardware_daemon_mock.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusVendingMachine } from "../target/types/baxus_vending_machine";
import * as crypto from "crypto";

async function main() {
  const provider = anchor.AnchorProvider.env();
  const program = anchor.workspace.BaxusVendingMachine as Program<BaxusVendingMachine>;

  console.log("Listening for SpinRevealedEvent on-chain...");

  program.addEventListener("SpinRevealedEvent", async (event, slot) => {
    console.log(`[EVENT] User ${event.user.toBase58()} won Tier: ${event.winningTier}`);
    console.log("Hardware: Triggering robotic stepper motors to dispense bottle...");
    
    // Simulate mechanical delay
    await new Promise((r) => setTimeout(r, 3000));
    console.log("Sensors: IR beam broken. Bottle dropped into customer tray.");

    // Sign confirmation
    const telemetryHash = crypto.randomBytes(32);
    console.log(`Hardware: Emitting confirmation with hash ${telemetryHash.toString("hex")}`);
  });
}

main().catch(console.error);