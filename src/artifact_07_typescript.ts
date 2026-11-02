// hardware-dispenser-node.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusSpinVault } from "./target/types/baxus_spin_vault";

async function monitorDispenser(machinePubkey: string) {
  const provider = anchor.AnchorProvider.env();
  const program = anchor.workspace.BaxusSpinVault as Program<BaxusSpinVault>;

  console.log(`[IoT Motor Controller] Listening for drops on Machine: ${machinePubkey}`);

  program.addEventListener("SpinFulfilled", (event, slot) => {
    console.log(`[DISPENSE TRIGGER] Slot: ${slot}`);
    console.log(` -> Winner: ${event.winner.toBase58()}`);
    console.log(` -> Tier: ${event.wonTier}`);
    console.log(` -> Auth Hash: 0x${Buffer.from(event.dispenseAuthHash).toString("hex")}`);
    
    // Actuate motor relay via GPIO / Serial
    triggerMotorRelay(event.wonTier);
  });
}

function triggerMotorRelay(slotId: number) {
  console.log(`[GPIO RELAY] Firing motor channel #${slotId} for physical drop... SUCCESS.`);
}