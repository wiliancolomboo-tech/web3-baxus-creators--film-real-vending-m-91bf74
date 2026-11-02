use anchor_lang::prelude::*;

pub const MACHINE_SEED: &[u8] = b"baxus_machine";
pub const SPIN_SEED: &[u8] = b"baxus_spin";
pub const ESCROW_SEED: &[u8] = b"baxus_escrow";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PrizeTier {
    StandardCraft = 0, // e.g., 100ml Artisanal Distilled Spirits
    PremiumBourbon = 1, // e.g., Blanton's Single Barrel / Eagle Rare
    UltraRareWhisky = 2, // e.g., Pappy Van Winkle / Macallan 25
    GrandReserveDecanter = 3, // e.g., Louis XIII Cognac
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SpinStatus {
    Committed,
    ResolvedWaitingDispense,
    Dispensed,
    Refunded,
}

#[account]
#[derive(Default)]
pub struct VendingMachine {
    pub authority: Pubkey,        // 32
    pub hardware_key: Pubkey,     // 32: Public key of the embedded IoT dispenser
    pub machine_id: u32,          // 4
    pub cost_per_spin_lamports: u64, // 8
    pub total_spins_completed: u64,  // 8
    pub active_spins_in_flight: u32, // 4
    pub max_shelves: u8,          // 1
    pub bump: u8,                 // 1
    pub is_active: bool,          // 1
    pub shelf_quantities: [u32; 8], // 32 (up to 8 physical shelves)
    pub shelf_tiers: [u8; 8],     // 8
}

impl VendingMachine {
    pub const LEN: usize = 8 + 32 + 32 + 4 + 8 + 8 + 4 + 1 + 1 + 1 + 32 + 8 + 64; // + padding
}

#[account]
pub struct SpinSession {
    pub machine: Pubkey,          // 32
    pub player: Pubkey,           // 32
    pub nonce: u64,               // 8
    pub user_commitment: [u8; 32],// 32 (SHA-256 of user preimage)
    pub operator_seed: [u8; 32],  // 32
    pub prize_tier: u8,           // 1
    pub allocated_shelf: u8,      // 1
    pub request_slot: u64,        // 8
    pub resolved_slot: u64,       // 8
    pub status: SpinStatus,       // 1
    pub bump: u8,                 // 1
}

impl SpinSession {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 32 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 32;
}

#[event]
pub struct SpinRequestedEvent {
    pub machine_id: u32,
    pub player: Pubkey,
    pub nonce: u64,
    pub request_slot: u64,
}

#[event]
pub struct SpinSettledEvent {
    pub machine_id: u32,
    pub player: Pubkey,
    pub nonce: u64,
    pub prize_tier: u8,
    pub shelf_id: u8,
}

#[event]
pub struct PhysicalDispenseCompletedEvent {
    pub machine_id: u32,
    pub player: Pubkey,
    pub nonce: u64,
    pub shelf_id: u8,
    pub timestamp: i64,
}