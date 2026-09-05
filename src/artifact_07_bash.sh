# 1. Clone repository and navigate to root
cd baxus-vending

# 2. Install dependencies
yarn install

# 3. Build Anchor program and verify CUs
anchor build

# 4. Generate localnet program keypair (or sync program ID)
anchor keys sync

# 5. Launch local validator and run complete test suite
anchor test