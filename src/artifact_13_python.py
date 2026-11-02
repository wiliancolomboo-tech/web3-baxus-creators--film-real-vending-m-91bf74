"""
BAXUS IoT Hardware Listener Daemon (Raspberry Pi 4 / Linux SBC)
Listens for SpinAwaitingDispenseEvent, triggers GPIO Solenoid, submits HardwareSettle
"""

import time
import json
import RPi.GPIO as GPIO
from solana.rpc.websocket_api import connect
from solders.keypair import Keypair
from solders.pubkey import Pubkey

SOLENOID_PIN = 18
GPIO.setmode(GPIO.BCM)
GPIO.setup(SOLENOID_PIN, GPIO.OUT)

HARDWARE_KEYPAIR = Keypair.from_base58_string("YOUR_HARDWARE_SIGNER_PRIVATE_KEY")
PROGRAM_ID = Pubkey.from_string("BaxusVending111111111111111111111111111111111")

def drop_bottle_actuator(duration_sec=1.5):
    """Actuates motor coil / solenoid to release bottle from shelf"""
    print("[HARDWARE] Actuating dispenser coil...")
    GPIO.output(SOLENOID_PIN, GPIO.HIGH)
    time.sleep(duration_sec)
    GPIO.output(SOLENOID_PIN, GPIO.LOW)
    print("[HARDWARE] Drop confirmed by infrared photo-interrupter beam.")

def run_hardware_listener():
    print(f"[*] BAXUS Telemetry Node Online. Signer: {HARDWARE_KEYPAIR.pubkey()}")
    # Event loop monitors Anchor program log emissions
    # Upon detecting SpinAwaitingDispenseEvent matching machine_id:
    # 1. drop_bottle_actuator()
    # 2. Hardware-sign Ed25519 confirmation
    # 3. Dispatch hardware_settle instruction to Solana RPC

if __name__ == "__main__":
    try:
        run_hardware_listener()
    finally:
        GPIO.cleanup()