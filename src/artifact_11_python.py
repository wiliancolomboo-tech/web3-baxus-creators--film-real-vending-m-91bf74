import asyncio
import json
from solana.rpc.websocket_api import connect
from solders.pubkey import Pubkey

VENDING_PROGRAM_ID = "BaxusVnd11111111111111111111111111111111111"
WS_ENDPOINT = "ws://127.0.0.1:8900"

async def monitor_dispense_events():
    async with connect(WS_ENDPOINT) as websocket:
        print(f"[*] Connected to Solana WebSocket: {WS_ENDPOINT}")
        # Subscribe to program logs
        await websocket.logs_subscribe(
            filter_=Pubkey.from_string(VENDING_PROGRAM_ID),
            commitment="finalized"
        )
        print(f"[*] Listening for finalized bottle dispense events on program {VENDING_PROGRAM_ID}...")

        while True:
            msg = await websocket.recv()
            for log in msg:
                if "SpinFulfilledEvent" in str(log):
                    print("[!] DISPENSE TRIGGER DETECTED ON-CHAIN!")
                    # In production: Trigger GPIO Pin on Raspberry Pi / Microcontroller
                    # Example: GPIO.output(SOLENOID_RELAY_PIN, GPIO.HIGH)
                    print("[+] Solenoid Actuated: Bottle Dropped.")

if __name__ == "__main__":
    asyncio.run(monitor_dispense_events())