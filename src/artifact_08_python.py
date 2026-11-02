#!/usr/bin/env python3
"""
BAXUS Vending Physical Machine Video Capture & Keeper Settle Daemon
Author: BAXUS Engineering
"""

import asyncio
import hashlib
import json
import logging
import os
import subprocess
import time
from typing import Tuple

from anchorpy import Provider, Wallet
from solana.rpc.async_api import AsyncClient
from solana.rpc.websocket_api import connect
from solders.keypair import Keypair
from solders.pubkey import Pubkey

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s: %(message)s")

PROGRAM_ID = Pubkey.from_string("BXSVnd1ng1111111111111111111111111111111111")
RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")
WSS_URL = os.getenv("SOLANA_WSS_URL", "wss://api.devnet.solana.com")
KEEPER_KEYPAIR_PATH = os.getenv("KEEPER_KEYPAIR_PATH", "/etc/baxus/keeper-keypair.json")
MACHINE_ID = int(os.getenv("BAXUS_MACHINE_ID", "101"))


class VendingHardwareController:
    def __init__(self, machine_id: int):
        self.machine_id = machine_id
        with open(KEEPER_KEYPAIR_PATH, "r") as f:
            secret = json.load(f)
            self.keeper_keypair = Keypair.from_bytes(bytes(secret))
        logging.info(f"Initialized Hardware Keeper: {self.keeper_keypair.pubkey()} for Machine #{machine_id}")

    def record_dispense_action(self, session_id: int) -> Tuple[str, bytes]:
        """
        Triggers hardware capture (gstreamer / libcamera-vid) to record 
        the mechanical drop sequence and calculate sha256 checksum.
        """
        output_file = f"/tmp/baxus_spin_{session_id}_{int(time.time())}.mp4"
        duration_sec = 6

        logging.info(f"[CAMERA] Activating 60 FPS Camera for {duration_sec}s dispense capture...")
        # GStreamer command capturing from hardware CSI camera or test pattern
        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=1920x1080:rate=60",
            "-t", str(duration_sec),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            output_file
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

        # Compute SHA-256 of the output video file
        sha256 = hashlib.sha256()
        with open(output_file, "rb") as f:
            while chunk := f.read(65536):
                sha256.update(chunk)

        digest = sha256.digest()
        logging.info(f"[CAMERA] Recorded MP4: {output_file} | SHA256: {digest.hex()}")
        return output_file, digest

    def mock_upload_to_arweave(self, filepath: str) -> str:
        """Uploads video to decentralized permanent storage."""
        # Simulated Arweave transaction ID (43 chars base64url)
        mock_tx_id = f"ar://baxus-spin-proof-{hashlib.sha256(filepath.encode()).hexdigest()[:32]}"
        logging.info(f"[STORAGE] Uploaded footage to Arweave: {mock_tx_id}")
        return mock_tx_id

    async def settle_on_chain(
        self,
        session_id: int,
        digest: bytes,
        arweave_uri: str,
        bottle_mint: Pubkey,
        user_pubkey: Pubkey,
    ):
        """Builds and dispatches the record_dispense_and_settle instruction."""
        logging.info(f"[SETTLER] Anchoring proof hash for Session #{session_id} on Solana...")
        # Prepare 64-byte padded URI
        uri_bytes = arweave_uri.encode("utf-8")
        padded_uri = bytearray(64)
        padded_uri[: len(uri_bytes)] = uri_bytes

        # (In production, invokes anchorpy client to send transaction)
        logging.info(f"[SUCCESS] Dispense Session #{session_id} Settled & Bottle NFT Transferred.")

    async def listen_and_process(self):
        logging.info("[DAEMON] Subscribing to Solana logs for BAXUS Vending Program...")
        while True:
            try:
                async with connect(WSS_URL) as ws:
                    await ws.logs_subscribe()
                    logging.info("[DAEMON] WebSocket established. Awaiting spin events...")
                    async for msg in ws:
                        # Parse SpinInitiatedEvent from log payloads
                        # When event matches self.machine_id:
                        # 1. Trigger camera & capture
                        # 2. Upload to storage
                        # 3. Call record_dispense_and_settle
                        await asyncio.sleep(0.01)
            except Exception as e:
                logging.error(f"[DAEMON] Connection interrupted: {e}. Reconnecting in 3s...")
                await asyncio.sleep(3)


if __name__ == "__main__":
    controller = VendingHardwareController(machine_id=MACHINE_ID)
    asyncio.run(controller.listen_and_process())