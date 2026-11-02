import asyncio
import os
import RPi.GPIO as GPIO
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey

IR_SENSOR_PIN = 17
SERVO_RELAY_PIN = 27

GPIO.setmode(GPIO.BCM)
GPIO.setup(IR_SENSOR_PIN, GPIO.IN, pull_up_down=GPIO.PUD_UP)
GPIO.setup(SERVO_RELAY_PIN, GPIO.OUT, initial=GPIO.LOW)

async def listen_for_spins():
    client = AsyncClient("https://api.devnet.solana.com")
    print("[*] BAXUS IoT Vending Keeper active. Awaiting Solana events...")
    
    while True:
        # Keeper listens to WebSocket program logs for ActuateChuteEvent
        # Upon receipt:
        # 1. Trigger servo
        GPIO.output(SERVO_RELAY_PIN, GPIO.HIGH)
        await asyncio.sleep(1.2)
        GPIO.output(SERVO_RELAY_PIN, GPIO.LOW)
        
        # 2. Wait for IR beam break
        bottle_dropped = False
        for _ in range(50): # 5-second polling window
            if GPIO.input(IR_SENSOR_PIN) == GPIO.LOW:
                bottle_dropped = True
                break
            await asyncio.sleep(0.1)
            
        if bottle_dropped:
            print("[+] Physical drop confirmed! Submitting confirm_dispense tx...")
            # Sign and submit confirm_dispense instruction
        else:
            print("[-] Jam detected. Aborting confirmation to allow user refund.")
        
        await asyncio.sleep(1)

if __name__ == "__main__":
    try:
        asyncio.run(listen_for_spins())
    except KeyboardInterrupt:
        GPIO.cleanup()