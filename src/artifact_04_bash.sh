# 1. Clone repository and navigate to root directory
git clone https://github.com/baxus-protocol/phygital-dispenser.git
cd phygital-dispenser

# 2. Install TypeScript dependencies
yarn install

# 3. Generate keypairs for local testing
solana-keygen new --no-bip39-passphrase -o ./target/deploy/baxus_vending-keypair.json --force

# 4. Sync Program ID across Anchor.toml and lib.rs
anchor keys sync

# 5. Build the Anchor program
anchor build