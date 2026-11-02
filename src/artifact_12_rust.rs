use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::attest_dispense::*;
use instructions::claim_refund::*;
use instructions::initialize::*;
use instructions::request_spin::*;
use instructions::stock_bottle::*;

declare_id!("BXSVend111111111111111111111111111111111111");

#[program]
pub mod baxus_vending {
    use super::*;

    pub fn initialize_machine(
        ctx: Context<InitializeMachine>,
        machine_id: u32,
        spin_price: u64,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, machine_id, spin_price)
    }

    pub fn stock_bottle(
        ctx: Context<StockBottle>,
        machine_id: u32,
        rarity_tier: u8,
    ) -> Result<()> {
        instructions::stock_bottle::handler(ctx, machine_id, rarity_tier)
    }

    pub fn request_spin(
        ctx: Context<RequestSpin>,
        machine_id: u32,
        nonce: u64,
    ) -> Result<()> {
        instructions::request_spin::handler(ctx, machine_id, nonce)
    }

    pub fn attest_dispense_and_film(
        ctx: Context<AttestDispenseAndFilm>,
        video_cid: [u8; 64],
        telemetry_hash: [u8; 32],
    ) -> Result<()> {
        instructions::attest_dispense::handler(ctx, video_cid, telemetry_hash)
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::claim_refund::handler(ctx)
    }
}