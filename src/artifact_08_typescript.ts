import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import * as crypto from "crypto";
import { Gpio } from "onoff"; // Hardware GPIO for Raspberry Pi drop sensor

// Hardware Pin Configuration
const IR_BEAM_PIN = 23;      // Low when bottle breaks IR beam
const MOTOR_RELAY_PIN = 24;  // Activates coil dispenser motor

class BaxusHardwareBridge {
  private connection: Connection;
  private hardwareKeypair: Keypair;
  private program: Program;
  private machineId: Buffer;
  private irSensor: any;
  private motorRelay: any;

  constructor(
    rpcUrl: string,
    hardwareKeypairRaw: Uint8Array,
    idl: any,
    programId: PublicKey,
    machineIdHex: string
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.hardwareKeypair = Keypair.fromSecretKey(hardwareKeypairRaw);
    this.machineId = Buffer.from(machineIdHex, "hex");

    const wallet = new Wallet(this.hardwareKeypair);
    const provider = new AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    this.program = new Program(idl, provider);

    // Initialize physical GPIOs
    this.irSensor = new Gpio(IR_BEAM_PIN, "in", "both");
    this.motorRelay = new Gpio(MOTOR_RELAY_PIN, "out");
    this.motorRelay.writeSync(0);
  }

  public async startListener(): Promise<void> {
    console.log(`[BAXUS-HW] Bridge active for Machine ID: ${this.machineId.toString("hex")}`);

    const [machinePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vending_machine"), this.machineId],
      this.program.programId
    );

    // Listen for SpinResolvedEvent on-chain
    this.program.addEventListener("SpinResolvedEvent", async (event: any, slot: number) => {
      console.log(`[BAXUS-HW] Spin Resolved: Session #${event.sessionId}, Tier: ${event.outcomeTier}`);

      if (event.outcomeTier > 0) {
        console.log(`[BAXUS-HW] Winning spin! Triggering physical dispense motor.`);
        const dispensed = await this.triggerDispenseSequence();
        await this.submitAttestation(machinePda, BigInt(event.sessionId), dispensed);
      } else {
        console.log(`[BAXUS-HW] Consolation spin. No mechanical actuation required.`);
      }
    });
  }

  private async triggerDispenseSequence(): Promise<boolean> {
    return new Promise((resolve) => {
      let dispensed = false;
      const timeout = setTimeout(() => {
        this.motorRelay.writeSync(0); // Cut power on timeout
        this.irSensor.unwatchAll();
        resolve(dispensed);
      }, 7000); // 7-second max cycle

      // Watch physical IR beam break
      this.irSensor.watch((err: any, value: number) => {
        if (err) return;
        if (value === 0) { // Beam interrupted by falling bottle
          dispensed = true;
          this.motorRelay.writeSync(0); // Stop motor immediately
          clearTimeout(timeout);
          this.irSensor.unwatchAll();
          resolve(true);
        }
      });

      // Turn on motor
      this.motorRelay.writeSync(1);
    });
  }

  private async submitAttestation(
    machinePda: PublicKey,
    sessionId: bigint,
    dispenseSuccess: boolean
  ): Promise<void> {
    const sessionBuffer = Buffer.alloc(8);
    sessionBuffer.writeBigUInt64LE(sessionId);

    const [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), machinePda.toBuffer(), sessionBuffer],
      this.program.programId
    );

    const [attestationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("attestation"), sessionPda.toBuffer()],
      this.program.programId
    );

    // Compute hardware proof hash
    const proofHash = crypto
      .createHash("sha256")
      .update(Buffer.concat([sessionBuffer, this.machineId]))
      .digest();

    const tx = await this.program.methods
      .attestPhysicalDispense(Array.from(proofHash), dispenseSuccess)
      .accounts({
        machine: machinePda,
        session: sessionPda,
        attestation: attestationPda,
        hardwareSigner: this.hardwareKeypair.publicKey,
        systemProgram: PublicKey.default,
      })
      .signers([this.hardwareKeypair])
      .rpc();

    console.log(`[BAXUS-HW] Attestation anchored on Solana: ${tx}`);
  }
}