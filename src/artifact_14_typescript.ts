import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { BaxusVendingMachine } from "../target/types/baxus_vending_machine";
import idl from "../target/idl/baxus_vending_machine.json";
import OBSWebSocket from "obs-websocket-js";
import * as fs from "fs";

// Hardware Serial / GPIO abstraction
class MachineHardwareController {
  public async triggerSpiralMotor(tierIndex: number): Promise<boolean> {
    console.log(`[HARDWARE] ⚙️ Actuating Physical Motor Spiral for Tier ${tierIndex}...`);
    // Simulate industrial relay pulse (2500ms motor spin)
    await new Promise((resolve) => setTimeout(resolve, 2500));
    console.log(`[HARDWARE] 🎯 Infrared Drop Sensor: BOTTLE PASS VERIFIED.`);
    return true;
  }
}

// Creator Studio Multi-Camera & OBS Controller
class CreatorStudioDirector {
  private obs: OBSWebSocket;
  private isConnected = false;

  constructor() {
    this.obs = new OBSWebSocket();
  }

  public async connect(url = "ws://127.0.0.1:4455", password?: string) {
    try {
      await this.obs.connect(url, password);
      this.isConnected = true;
      console.log("[STUDIO] 🎥 Connected to Creator Studio OBS WebSocket Engine.");
    } catch (err) {
      console.warn("[STUDIO] ⚠️ OBS WebSocket offline. Running in local creator studio emulation mode.");
    }
  }

  public async onSpinInitiated(user: string, spinIndex: number) {
    console.log(`[STUDIO] 🎬 SCENE 1: 'Creator Reaction' & Kiosk Spin Countdown Active`);
    if (this.isConnected) {
      await this.obs.call("SetCurrentProgramScene", { sceneName: "Spin_Action_Angle" });
      await this.obs.call("StartRecord");
    }
  }

  public async onSpinResult(tier: string, bottleMint: string) {
    console.log(`[STUDIO] 🌟 SCENE 2: Spotlight Machine Vault Bin -> Result: [${tier}] Mint: ${bottleMint}`);
    if (this.isConnected) {
      await this.obs.call("SetInputSettings", {
        inputName: "RWA_HUD_Overlay",
        inputSettings: { text: `WINNER! Tier: ${tier}\nRWA Mint: ${bottleMint.slice(0, 8)}...` },
      });
      await this.obs.call("SetCurrentProgramScene", { sceneName: "Bottle_Drop_SlowMo" });
    }
  }

  public async finalizeRecording(ticketIndex: number) {
    console.log(`[STUDIO] 💾 Recording Saved for Ticket #${ticketIndex}. Generating Creator Deliverable.`);
    if (this.isConnected) {
      await new Promise((r) => setTimeout(r, 4000));
      await this.obs.call("StopRecord");
    }
  }
}

// Edge Keeper Main Loop
async function runDispenserDaemon() {
  const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const WS_URL = process.env.SOLANA_WS_URL || "ws://127.0.0.1:8900";
  const connection = new Connection(RPC_URL, { wsEndpoint: WS_URL, commitment: "confirmed" });

  const rawHardwareKey = JSON.parse(
    fs.readFileSync(process.env.HARDWARE_KEYPAIR_PATH || "./hardware-keypair.json", "utf-8")
  );
  const hardwareSigner = Keypair.fromSecretKey(Uint8Array.from(rawHardwareKey));
  const provider = new AnchorProvider(connection, new Wallet(hardwareSigner), { commitment: "confirmed" });
  const program = new Program<BaxusVendingMachine>(idl as any, provider);

  const hardware = new MachineHardwareController();
  const studio = new CreatorStudioDirector();
  await studio.connect();

  const MACHINE_ID = 101;
  const PROGRAM_ID = new PublicKey("BAXUSvm111111111111111111111111111111111111");

  console.log(`[DAEMON] 🚀 BAXUS Physical Vending Keeper active for Machine #${MACHINE_ID}`);
  console.log(`[DAEMON] Hardware Signer: ${hardwareSigner.publicKey.toBase58()}`);

  // Subscribe to Program Event Logs
  program.addEventListener("spinRequestedEvent", async (event) => {
    if (event.machineId !== MACHINE_ID) return;
    console.log(`\n======================================================`);
    console.log(`🎲 NEW SPIN INITIATED on Machine #${event.machineId}`);
    console.log(`Ticket Index: ${event.spinIndex.toString()} | User: ${event.user.toBase58()}`);
    console.log(`======================================================`);

    await studio.onSpinInitiated(event.user.toBase58(), event.spinIndex.toNumber());

    // Fulfill spin off-chain keeper transaction
    const seed = Buffer.alloc(32);
    crypto.getRandomValues(seed);

    console.log(`[DAEMON] Sending fulfill_spin instruction to Solana...`);
    try {
      const tx = await program.methods
        .fulfillSpin(MACHINE_ID, event.spinIndex, Array.from(seed))
        .accountsPartial({
          caller: hardwareSigner.publicKey,
          slotHashes: new PublicKey("SysvarS1otHashes111111111111111111111111111"),
        })
        .rpc();
      console.log(`[DAEMON] Spin settled on-chain: Signature ${tx}`);
    } catch (e) {
      console.error("[DAEMON] Error fulfilling spin:", e);
    }
  });

  program.addEventListener("spinFulfilledEvent", async (event) => {
    if (event.machineId !== MACHINE_ID) return;
    const tierNames = ["Common", "Reserve", "Rare", "Grail"];
    const tierName = tierNames[Number(event.wonTier)] ?? "Unknown";

    console.log(`\n🎉 SPIN REVEALED: Ticket #${event.spinIndex.toString()} WON ${tierName}!`);
    console.log(`Bottle Mint: ${event.bottleMint.toBase58()}`);

    // Update Creator Studio overlay
    await studio.onSpinResult(tierName, event.bottleMint.toBase58());

    // Actuate physical machine rack
    const dropSuccess = await hardware.triggerSpiralMotor(Number(event.wonTier));

    if (dropSuccess) {
      console.log(`[DAEMON] Submitting ackHardwareDispense signature to Solana...`);
      const ackTx = await program.methods
        .ackHardwareDispense(MACHINE_ID, event.spinIndex)
        .accountsPartial({
          hardwareSigner: hardwareSigner.publicKey,
        })
        .rpc();

      console.log(`[DAEMON] Physical Dispense On-Chain Confirmed! Tx: ${ackTx}`);
      await studio.finalizeRecording(event.spinIndex.toNumber());
    }
  });

  // Keep daemon alive
  setInterval(() => {}, 1000);
}

if (require.main === module) {
  runDispenserDaemon().catch(console.error);
}