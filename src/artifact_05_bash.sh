# Clone the repository workspace
git clone https://github.com/baxus-protocol/baxus-vending-machine.git
cd baxus-vending-machine

# Install NPM dependencies
yarn install

# Build Anchor program
anchor build

# Sync Program ID across declare_id! and Anchor.toml
anchor keys sync