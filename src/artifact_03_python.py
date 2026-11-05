#!/usr/bin/env python3
import asyncio
import hashlib
import json
import logging
import os
import subprocess
import time
from pathlib import Path
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.transaction import Transaction
from solders.hash import Hash

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

RPC_URL = os.getenv("SOLANA_RPC_URL", "http://127.0.0.1:8899")
PROGRAM_ID = Pubkey.from_string("BXSVnd9uQ1nB4m2hZ3c2V9tG1oA7w4kL5p8XqPmM7yR")
MACHINE_ID = int(os.getenv("MACHINE_ID", "101"))
VIDEO_STORAGE_PATH = Path("/tmp/baxus_recordings")
VIDEO_STORAGE_PATH.mkdir(parents=True, exist_ok=True)

class VendingHardwareController:
    def __init__(self, hardware_keypair: Keypair):
        self.hardware_keypair = hardware_keypair
        self.client = AsyncClient(RPC_URL)

    async def poll_for_dispense_tickets(self):
        logging.info("Vending Hardware Daemon Active. Listening for AwaitingDispense states...")
        while True:
            try:
                # In production, subscribe via Solana WSS logsSubscribe or programSubscribe
                await asyncio.sleep(2)
            except Exception as e:
                logging.error(f"Error in polling loop: {e}")
                await asyncio.sleep(5)

    def trigger_camera_recording(self, ticket_id: str, duration_sec: int = 12) -> str:
        """Triggers local 4K rig (libcamera-vid / ffmpeg) and returns output file path."""
        output_file = VIDEO_STORAGE_PATH / f"dispense_{ticket_id}_{int(time.time())}.mp4"
        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30",  # Mock sensor stream for dev
            "-t", str(duration_sec),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            str(output_file)
        ]
        logging.info(f"Recording dispense footage to {output_file}...")
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return str(output_file)

    def compute_sha256(self, filepath: str) -> bytes:
        hasher = hashlib.sha256()
        with open(filepath, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)
        return hasher.digest()

    def simulate_hardware_test_000000000000000000000000(self, slot_id: int) -> bool:
        logging.info(f"Actuating coil motor for Slot #{slot_id}...")
        time.sleep(2.5) # Simulating physical motor rotation
        logging.info("IR Drop Array: Beam break detected! Bottle settled into delivery bay.")
        return True

    def sign_telemetry_payload(self, ticket_pubkey: bytes, slot_id: int, timestamp: int, video_hash: bytes) -> bytes:
        payload = ticket_pubkey + bytes([slot_id]) + timestamp.to_bytes(8, "little") + video_hash
        message_hash = hashlib.sha256(payload).digest()
        # Sign the digest with hardware keypair
        sig = self.hardware_keypair.sign_message(message_hash)
        return bytes(sig)

    async def execute_dispense_cycle(self, ticket_pubkey_str: str, slot_id: int):
        ticket_pubkey = Pubkey.from_string(ticket_pubkey_str)
        logging.info(f"Beginning Automated Dispense Protocol for Ticket: {ticket_pubkey}")

        # 1. Start camera recording in parallel
        record_task = asyncio.to_thread(self.trigger_camera_recording, str(ticket_pubkey)[:8], 10)

        # 2. Actuate Physical Motors
        drop_success = await asyncio.to_thread(self.simulate_hardware_test_000000000000000000000000, slot_id)
        if not drop_success:
            logging.error("Mechanical drop failure! Jam registered.")
            return

        video_path = await record_task
        video_hash = self.compute_sha256(video_path)
        timestamp = int(time.time())

        logging.info(f"Filming completed. Raw video: {video_path}")
        logging.info(f"Calculated SHA-256 Root Hash: {video_hash.hex()}")

        # 3. Hardware cryptographic attestation
        signature = self.sign_telemetry_payload(bytes(ticket_pubkey), slot_id, timestamp, video_hash)
        logging.info(f"Generated Ed25519 Enclave Signature: {signature.hex()[:32]}...")

        # 4. Construct on-chain finalize_dispense instruction and submit
        logging.info("Submitting finalize_dispense transaction to Solana Cluster...")
        # (Anchor finalize_dispense CPI invocation omitted for brevity)

if __name__ == "__main__":
    hw_key = Keypair()
    controller = VendingHardwareController(hw_key)
    asyncio.run(controller.execute_dispense_cycle("8F3N5Q2V1wK9mZbP4eRt7uY6oA5sD3fG2hJ1kL0xX9c", slot_id=3))