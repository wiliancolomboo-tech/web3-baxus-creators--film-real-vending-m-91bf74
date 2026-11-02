# 1. Start local Solana test validator
solana-test-validator --reset --quiet &

# 2. Run the full test suite against localnet
anchor test --skip-local-validator