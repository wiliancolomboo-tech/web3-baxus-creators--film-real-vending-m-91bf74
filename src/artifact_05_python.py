#!/usr/bin/env python3
"""
BAXUS Physical Vending Machine IoT Edge Daemon
Controls Relay Solenoids, Monitors IR Beam Drop-Sensors, and Settles On-Chain Claims.
"""

import os
import time
import json
import asyncio
from typing import Dict, Any
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solana.rpc.async_api import AsyncClient
from solana.rpc.websocket_api import connect
import RPi.GPIO as GPIO  # Hardware GPIO controller

# Hardware Pin Mapping
RELAY_PINS = {
    0: 17,  # Tier 0 (Grail Motor)
    1: 27,  # Tier 1 (Rare Motor)
    2: 22,  # Tier 2 (Mid Motor)
    3: 23   # Tier 3 (Pours / Samples)
}
DROP_SENSOR_PIN = 24  # Infrared Beam Break

PROGRAM_ID = Pubkey.from_string("BXSVnd1111111111111111111111111111111111111")
MACHINE_ID = 42

class BaxusVendingHardwareController:
    def __init__(self, keypair_path: str, rpc_ws_url: str):
        self.rpc_ws_url = rpc_ws_url
        with open(keypair_path, "r") as f:
            secret = json.load(f)
            self.hardware_keypair = Keypair.from_bytes(bytes(secret))
        
        self.setup_gpio()

    def setup_gpio(self):
        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        for pin in RELAY_PINS.values():
            GPIO.setup(pin, GPIO.OUT)
            GPIO.output(pin, GPIO.HIGH) # Active LOW relays
        GPIO.setup(DROP_SENSOR_PIN, GPIO.IN, pull_up_down=GPIO.PUD_UP)

    def trigger_physical_dispense(self, tier: int) -> bool:
        pin = RELAY_PINS.get(tier)
        if not pin:
            print(f"[ERROR] Invalid tier: {tier}")
            return False

        print(f"[HARDWARE] Actuating spiral motor relay on GPIO pin {pin} for Tier {tier}...")
        GPIO.output(pin, GPIO.LOW) # Turn on motor
        
        start_time = time.time()
        dispensed = False

        # Wait up to 8 seconds for IR sensor drop confirmation
        while time.time() - start_time < 8.0:
            if GPIO.input(DROP_SENSOR_PIN) == GPIO.LOW:  # Beam broken by falling bottle
                dispensed = True
                print("[HARDWARE] Sensor beam broken! Physical bottle dropped successfully.")
                break
            time.sleep(0.05)

        GPIO.output(pin, GPIO.HIGH) # Turn off motor
        return dispensed

    async def run(self):
        print(f"[KEEPER] Connecting to Solana Event WebSocket for Program {PROGRAM_ID}...")
        async with connect(self.rpc_ws_url) as websocket:
            await websocket.logs_subscribe()
            print("[KEEPER] Subscribed to program execution logs. Listening for spin events...")

            async for msg in websocket:
                for log in msg:
                    # In production, parse Anchor program event base64 data
                    if "SpinSettledEvent" in str(log):
                        print(f"[EVENT] Detected settled spin: {log}")
                        # Extract event data (mocked for loop execution)
                        tier = 0
                        spin_index = 0
                        
                        success = self.trigger_physical_dispense(tier)
                        if success:
                            print(f"[CHAIN] Submitting claim_dispensation for spin {spin_index}...")
                            # Call on-chain claim_dispensation signed by self.hardware_keypair

    def cleanup(self):
        GPIO.cleanup()

if __name__ == "__main__":
    controller = BaxusVendingHardwareController(
        keypair_path=os.getenv("HARDWARE_KEYPAIR", "./edge_keypair.json"),
        rpc_ws_url=os.getenv("SOLANA_WS_URL", "wss://api.devnet.solana.com")
    )
    try:
        asyncio.run(controller.run())
    except KeyboardInterrupt:
        controller.cleanup()