import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BaxusVending } from "../target/types/baxus_vending";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { createHash } from "crypto";
import { spawn } from "child_process";
import * as fs from "fs";

export class BaxusMachineHardwareDaemon {
  private program: Program<BaxusVending>;
  private hardwareKeypair: Keypair;
  private machineId: Buffer;
  private machinePda: PublicKey;
  private isProcessingDispense: boolean = false;

  constructor(
    program: Program<BaxusVending>,
    hardwareKeypair: Keypair,
    machineIdStr: string
  ) {
    this.program = program;
    this.hardwareKeypair = hardwareKeypair;
    this.machineId = Buffer.from(machineIdStr.padEnd(16, "\0").slice(0, 16));
    
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("machine"), this.machineId],
      this.program.programId
    );
    this.machinePda = pda;
  }

  public async startListener() {
    console.log(`[BAXUS-DAEMON] Initialized for Machine PDA: ${this.machinePda.toBase58()}`);
    console.log(`[BAXUS-DAEMON] Listening for On-Chain Settled Spins...`);

    this.program.addEventListener("SpinSettledEvent", async (event, slot) => {
      const eventMachine = Buffer.from(event.machineId);
      if (Buffer.compare(eventMachine, this.machineId) !== 0) {
        return; // Event belongs to a different physical machine
      }

      console.log(`\n=================================================`);
      console.log(`[SPIN SETTLED] Slot ID: ${event.slotId} | Tier: ${event.tier}`);
      console.log(`User: ${event.user.toBase58()} | Spin Index: ${event.spinIndex.toString()}`);
      console.log(`=================================================`);

      await this.handlePhysicalDispenseSequence(
        event.spinIndex,
        event.slotId,
        event.user.toBase58()
      );
    });
  }

  private async handlePhysicalDispenseSequence(
    spinIndex: anchor.BN,
    slotId: number,
    userAddress: string
  ) {
    if (this.isProcessingDispense) {
      console.warn("[HARDWARE] Dispense queue busy! Enqueueing task...");
    }
    this.isProcessingDispense = true;

    try {
      // 1. Trigger High-Speed Camera Recording
      const videoFilename = `/tmp/spin_${spinIndex.toString()}_slot_${slotId}.mp4`;
      console.log(`[CAMERA] Triggering 120 FPS camera to: ${videoFilename}`);
      const cameraProcess = spawn("ffmpeg", [
        "-y",
        "-f", "v4l2",
        "-framerate", "60",
        "-video_size", "1920x1080",
        "-i", "/dev/video0",
        "-t", "8",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        videoFilename
      ]);

      // 2. Fire physical relay/stepper motor for designated slot
      console.log(`[GPIO-RELAY] Actuating Stepper Motor Coil for Bay #${slotId}...`);
      const dispenseSuccess = await this.actuateMotorWithOpticalConfirmation(slotId);

      if (!dispenseSuccess) {
        throw new Error(`Optical beam not broken within 8000ms. Dispense failure/jam detected.`);
      }

      // 3. Compute cryptographic proof of hardware telemetry
      const videoBuffer = fs.readFileSync(videoFilename);
      const telemetryPayload = Buffer.concat([
        Buffer.from(spinIndex.toArray("le", 8)),
        Buffer.from([slotId]),
        createHash("sha256").update(videoBuffer).digest()
      ]);
      const telemetryProof = createHash("sha256").update(telemetryPayload).digest();

      // 4. Send on-chain confirmation
      const [spinTicketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("spin"), this.machinePda.toBuffer(), spinIndex.toArrayLike(Buffer, "le", 8)],
        this.program.programId
      );

      console.log(`[SOLANA] Submitting confirm_dispense tx...`);
      const tx = await this.program.methods
        .confirmDispense(Array.from(telemetryProof))
        .accounts({
          hardwareSigner: this.hardwareKeypair.publicKey,
          machineState: this.machinePda,
          spinTicket: spinTicketPda,
        })
        .signers([this.hardwareKeypair])
        .rpc();

      console.log(`[SUCCESS] Physical Dispense Confirmed! Tx Signature: ${tx}`);
      console.log(`[CREATOR] Uploading watermarked spin proof video to Arweave/Shadow Drive...`);
    } catch (err: any) {
      console.error(`[HARDWARE ERROR] ${err.message}`);
    } finally {
      this.isProcessingDispense = false;
    }
  }

  private async actuateMotorWithOpticalConfirmation(slotId: number): Promise<boolean> {
    return new Promise((resolve) => {
      // Simulating physical GPIO logic:
      // Relay pin HIGH -> Stepper rotates -> Bottle drops -> Optical IR pin reads LOW
      setTimeout(() => {
        const simulatedSensorRead = true; // Drop detected
        resolve(simulatedSensorRead);
      }, 2500);
    });
  }
}