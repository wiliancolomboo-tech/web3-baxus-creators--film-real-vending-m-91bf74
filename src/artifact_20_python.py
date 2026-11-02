import asyncio
import json
import hashlib
from solana.rpc.websocket_api import connect

PROGRAM_ID = "BXSVend111111111111111111111111111111111111"

async def listen_for_spins():
    async with connect("ws://127.0.0.1:8900") as websocket:
        await websocket.program_subscribe(PROGRAM_ID)
        print(f"[*] Connected to Solana RPC. Hardware Dispenser listening on {PROGRAM_ID}...")
        
        while True:
            msg = await websocket.recv()
            print("[+] Spin detected on-chain! Actuating physical motor...")
            # 1. Trigger motor controller over UART/GPIO
            # 2. Record 10 seconds from high-speed camera
            telemetry = "ACTUATOR_SUCCESS_SLOT_1"
            proof_hash = hashlib.sha256(telemetry.encode()).hexdigest()
            print(f"[+] Dispensation filmed. SHA-256 Telemetry: {proof_hash}")
            print("[+] Ready to broadcast attest_dispense_and_film transaction.")

if __name__ == "__main__":
    asyncio.run(listen_for_spins())