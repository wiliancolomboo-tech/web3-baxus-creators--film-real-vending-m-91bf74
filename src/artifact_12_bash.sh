export MACHINE_ID=888
export SOLANA_RPC_URL="http://127.0.0.1:8899"
export SOLANA_WS_URL="ws://127.0.0.1:8900"
export RTSP_STREAM_URL="rtsp://localhost:8554/live"

# Start the edge listener daemon
ts-node services/dispenser-daemon.ts