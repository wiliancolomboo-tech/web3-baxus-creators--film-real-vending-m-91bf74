# edge_daemon.py
import asyncio
import json
import websockets
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair

HARDWARE_KEY = Keypair.from_base58_string("YOUR_IOT_ENCLAVE_PRIVATE_KEY")
PROGRAM_ID = "BXSVnd1111111111111111111111111111111111111"

async def monitor_dispense():
    uri = "wss://api.devnet.solana.com"
    async with websockets.connect(uri) as ws:
        # Subscribe to program logs
        subscribe_msg = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "logsSubscribe",
            "params": [{"mentions": [PROGRAM_ID]}, {"commitment": "confirmed"}]
        }
        await ws.send(json.dumps(subscribe_msg))
        print(f"[*] Edge Daemon listening for BAXUS Vending Machine Events...")

        while True:
            msg = await ws.recv()
            data = json.loads(msg)
            # Parse SpinResolvedEvent and trigger physical GPIO pin
            # On optical drop sensor trip -> Submit confirm_dispense tx
            print(f"[+] Event received from Solana: {data}")

if __name__ == "__main__":
    asyncio.run(monitor_dispense())