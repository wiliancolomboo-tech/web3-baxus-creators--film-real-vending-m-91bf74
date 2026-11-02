# Generate mock hardware keypair
solana-keygen new --no-bip39-passphrase -o hardware-keypair.json --force

# Launch the Keeper / OBS Director Daemon
export SOLANA_RPC_URL="http://127.0.0.1:8899"
export SOLANA_WS_URL="ws://127.0.0.1:8900"
export HARDWARE_KEYPAIR_PATH="./hardware-keypair.json"

npx ts-node keeper/dispenser_daemon.ts