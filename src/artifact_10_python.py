#!/usr/bin/env python3
"""
BAXUS IoT Vending Machine Edge Attestation Daemon
Listens for SpinWonEvent, activates physical dispense relay, records drop,
and signs the video hash using the machine's hardware key.
"""

import hashlib
import time
from nacl.signing import SigningKey

def simulate_edge_dispense(ticket_pda: str, slot_id: int):
    print(f"[*] Processing dispense for Ticket PDA: {ticket_pda} at Slot: {slot_id}")
    
    # 1. Trigger GPIO Motor Relay
    print("[*] Activating GPIO Pin 18: Motor coil turning...")
    time.sleep(1.5)
    
    # 2. Drop Sensor Trip Verification
    optical_beam_tripped = True
    assert optical_beam_tripped, "ERROR: Optical drop sensor failed to trigger"
    print("[+] Break-beam sensor tripped: Bottle physically dispensed!")
    
    # 3. Hash Camera Stream
    mock_mp4_bytes = f"RECORDING_OF_SPIN_{ticket_pda}_{time.time()}".encode("utf-8")
    video_sha256 = hashlib.sha256(mock_mp4_bytes).hexdigest()
    print(f"[+] 4K Camera Video Captured. SHA256: {video_sha256}")
    
    # 4. Sign Payload with Machine Enclave Private Key
    hardware_seed = b"\x07" * 32
    signing_key = SigningKey(hardware_seed)
    payload_to_sign = bytes.fromhex(video_sha256) + int(time.time()).to_bytes(8, "little")
    signature = signing_key.sign(payload_to_sign).signature
    
    print(f"[+] Edge Hardware Signature Generated: {signature.hex()[:32]}...")
    print("[+] Ready to broadcast `confirm_dispense_and_attest` transaction on-chain.\n")

if __name__ == "__main__":
    simulate_edge_dispense("TktBXSVnd99201928301823901823091823901823091", 3)