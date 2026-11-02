use anchor_lang::prelude::*;

#[account]
pub struct MachineConfig {
    pub admin: Pubkey,
    pub keeper_authority: Pubkey,
    pub payment_mint: Pubkey,
    pub treasury_wallet: Pubkey,
    pub total_machines: u64,
    pub bump: u8,
}

impl MachineConfig {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum TierType {
    LegendaryWhiskey, // 0.5% - Rare Pappy Van Winkle / Macallan 25+
    UltraRareSpirits, // 4.5% - Blanton's Gold, High-end Bourbon
    CuratedRare,      // 20.0% - Special editions, Glenfiddich 18
    CollectorPour,    // 75.0% - Premium Curated Tasting expression
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct TierProbability {
    pub tier: u8,
    pub weight_bps: u16,        // Basis points (Total: 10,000 = 100%)
    pub bottle_mint: Pubkey,     // SPL Token-2022 representing vaulted bottle
    pub current_inventory: u32,  // Stock in vending chassis
}

#[account]
pub struct VendingMachinePool {
    pub machine_id: u64,
    pub machine_name: [u8; 32],
    pub authority: Pubkey,
    pub spin_price_atomic: u64, // Cost in payment_mint (USDC atomic units)
    pub total_spins_executed: u64,
    pub is_active: bool,
    pub tiers: [TierProbability; 4],
    pub bump: u8,
}

impl VendingMachinePool {
    // 8 + 8 + 32 + 32 + 8 + 8 + 1 + (4 * (1 + 2 + 32 + 4)) + 1 = 254 bytes
    pub const LEN: usize = 8 + 8 + 32 + 32 + 8 + 8 + 1 + (4 * 39) + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    SpinInitiated,
    DispensedAndVerified,
    FailedDispenseRefunded,
}

#[account]
pub struct DispenseSession {
    pub session_id: u64,
    pub machine_id: u64,
    pub user: Pubkey,
    pub awarded_tier: u8,
    pub awarded_mint: Pubkey,
    pub spin_slot: u64,
    pub client_seed: [u8; 32],
    pub video_proof_hash: [u8; 32], // SHA-256 of the 4K recording
    pub arweave_uri: [u8; 64],      // Arweave transaction manifest ID
    pub status: SessionStatus,
    pub bump: u8,
}

impl DispenseSession {
    // 8 + 8 + 8 + 32 + 1 + 32 + 8 + 32 + 32 + 64 + 1 + 1 = 227 bytes
    pub const LEN: usize = 8 + 8 + 8 + 32 + 1 + 32 + 8 + 32 + 32 + 64 + 1 + 1;
}