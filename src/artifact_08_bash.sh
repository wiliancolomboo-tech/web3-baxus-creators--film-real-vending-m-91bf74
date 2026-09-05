# Set environment variables for the machine
export ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
export ANCHOR_WALLET="~/.config/solana/hardware-machine-keypair.json"
export MACHINE_ID="BAXUS_NYC_VEND01"

# Launch the IoT listener daemon
ts-node edge-daemon/machine_controller.ts