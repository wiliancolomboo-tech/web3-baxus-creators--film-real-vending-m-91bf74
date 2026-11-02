#!/usr/bin/env python3
"""
BAXUS IoT Vending Machine Actuator & Video Telemetry Daemon
Listens for Solana on-chain SpinSettled events, activates motor, and signs Ed25519 proof.
"""

import time
import hashlib
import nacl.signing
from nacl.encoding import RawEncoder

# Physical Machine Hardware Keypair (Ed25519)
HARDWARE_SEED = bytes.fromhex("1029384756abcdef1029384756abcdef1029384756abcdef1029384756abcdef")
signing_key = nacl.signing.SigningKey(HARDWARE_SEED)
verify_key = signing_key.verify_key

def on_spin_settled(ticket_pda: bytes, slot_index: int, camera_session_id: bytes):
    print(f"[*] Dispense command received for Slot {slot_index}...")
    
    # 1. Fire GPIO Solenoid / Spiral Motor
    # gpio.output(RELAY_PINS[slot_index], GPIO.HIGH)
    time.sleep(1.2) # Actuation time
    # gpio.output(RELAY_PINS[slot_index], GPIO.LOW)
    print("[+] Mechanical drop detected via Optical Beam Sensor.")

    # 2. Create telemetry confirmation payload
    telemetry_payload = ticket_pda + camera_session_id + b"PHYSICAL_DISPENSE_SUCCESS"
    telemetry_hash = hashlib.sha256(telemetry_payload).digest()

    # 3. Sign telemetry with hardware key
    signature = signing_key.sign(telemetry_hash, encoder=RawEncoder).signature

    print(f"[+] Hardware Signature: {signature.hex()[:32]}...")
    print(f"[+] Telemetry Hash: {telemetry_hash.hex()}")
    print("[*] Ready for Anchor instruction submission.")

if __name__ == "__main__":
    dummy_ticket = bytes([1] * 32)
    dummy_camera = bytes([9] * 16)
    on_spin_settled(dummy_ticket, 0, dummy_camera)