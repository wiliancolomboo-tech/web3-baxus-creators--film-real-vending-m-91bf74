use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::*;

declare_id!("BAXUSvm111111111111111111111111111111111111");

#[program]
pub mod baxus_vending_machine {
    use super::*;

    pub fn initialize_machine(
        ctx: Context<InitializeMachine>,
        machine_id: u32,
        cost_per_spin: u64,
        tiers: [TierConfig; MAX_TIERS],
    ) -> Result<()> {
        instructions::initialize::handler(ctx, machine_id, cost_per_spin, tiers)
    }

    pub fn request_spin(
        ctx: Context<RequestSpin>,
        machine_id: u32,
        user_commitment: [u8; 32],
    ) -> Result<()> {
        instructions::request_spin::handler(ctx, machine_id, user_commitment)
    }

    pub fn fulfill_spin(
        ctx: Context<FulfillSpin>,
        machine_id: u32,
        spin_index: u64,
        entropy_seed: [u8; 32],
    ) -> Result<()> {
        instructions::fulfill_spin::handler(ctx, machine_id, spin_index, entropy_seed)
    }

    pub fn ack_hardware_dispense(
        ctx: Context<AckHardwareDispense>,
        machine_id: u32,
        spin_index: u64,
    ) -> Result<()> {
        instructions::ack_dispense::handler(ctx, machine_id, spin_index)
    }
}