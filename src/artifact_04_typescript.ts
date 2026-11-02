import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { BaxusVending } from "../target/types/baxus_vending";
import * as fs from "fs";
import { SerialPort } from "serialport";

// Hardware Configuration
const SERIAL_DEVICE_PATH = process.env.SERIAL_PORT || "/dev/ttyACM0";
const SERIAL_BAUD_RATE = 115200;

interface DispenseCommand {
  type: "DISPENSE_TRIGGER";
  slotId: number;
  recipient: string;
  sku: string;
  txSignature: string;
}

class BaxusHardwareRelay {
  private program: Program<BaxusVending>;
  private serialPort: SerialPort;

  constructor(program: Program<BaxusVending>) {
    this.program = program;
    this.serialPort = new SerialPort({
      path: SERIAL_DEVICE_PATH,
      baudRate: SERIAL_BAUD_RATE,
      autoOpen: false,
    });
  }

  public async start(): Promise<void> {
    console.log("==================================================");
    console.log("   BAXUS Physical Vending Machine Relay Service   ");
    console.log("==================================================");

    await this.initSerial();

    console.log("Connecting WebSocket to Solana transaction log stream...");
    this.program.addEventListener(
      "DispenseTelemetryEvent",
      async (event, slot, signature) => {
        await this.handleDispenseEvent(event, signature);
      }
    );

    console.log("Hardware listener active. Standing by for spins...");
  }

  private initSerial(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.serialPort.open((err) => {
        if (err) {
          console.warn(`[SERIAL MOCK] Running without direct hardware port: ${err.message}`);
          resolve();
        } else {
          console.log(`[HARDWARE] Connected to physical controller at ${SERIAL_DEVICE_PATH}`);
          resolve();
        }
      });
    });
  }

  private async handleDispenseEvent(event: any, signature: string): Promise<void> {
    const skuStr = Buffer.from(event.itemSku)
      .toString("utf8")
      .replace(/\0/g, "");

    const payload: DispenseCommand = {
      type: "DISPENSE_TRIGGER",
      slotId: event.slotId,
      recipient: event.recipient.toBase58(),
      sku: skuStr,
      txSignature: signature,
    };

    console.log("\n[EVENT RECEIVED] Real Spin Executed On-Chain!");
    console.log(`| Machine:  #${event.machineId.toString()}`);
    console.log(`| Slot ID:  ${payload.slotId}`);
    console.log(`| SKU:      ${payload.sku}`);
    console.log(`| Winner:   ${payload.recipient}`);
    console.log(`| Tx Sig:   ${payload.txSignature}`);

    await this.dispatchToMotorController(payload);
  }

  private async dispatchToMotorController(cmd: DispenseCommand): Promise<void> {
    const message = JSON.stringify(cmd) + "\n";

    if (this.serialPort.isOpen) {
      this.serialPort.write(message, (err) => {
        if (err) {
          console.error("[HARDWARE ERROR] Failed writing to motor controller:", err);
        } else {
          console.log(`[HARDWARE] Microcontroller signaled: Motor #${cmd.slotId} dispensing...`);
        }
      });
    } else {
      console.log(`[HARDWARE EMULATION] Motor Slot #${cmd.slotId} actuated (3.5 sec pulse).`);
      console.log(`[CINEMATIC CAM] Triggered Studio Lighting Sequence & Camera Dolly Focus.`);
    }
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.BaxusVending as Program<BaxusVending>;

  const relay = new BaxusHardwareRelay(program);
  await relay.start();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}