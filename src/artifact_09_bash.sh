# Inspect initialized machine state PDA
solana account <DERIVED_MACHINE_PDA> --output json-compact

# Verify USDC balance in Escrow Vault PDA
spl-token balance --address <ESCROW_VAULT_PDA>