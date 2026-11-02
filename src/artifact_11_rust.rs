use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::*;

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vending_machine", vending_machine.machine_id.to_le_bytes().as_ref()],
        bump = vending_machine.bump
    )]
    pub vending_machine: Account<'info, VendingMachine>,

    #[account(
        mut,
        seeds = [b"spin_session", user.key().as_ref(), spin_session.nonce.to_le_bytes().as_ref()],
        bump = spin_session.bump,
        constraint = spin_session.user == user.key(),
        constraint = spin_session.status == SpinStatus::AwaitingPhysicalDispense @ VendingError::InvalidSpinStatus
    )]
    pub spin_session: Account<'info, SpinSession>,

    /// CHECK: Validated against vending_machine treasury
    #[account(mut, address = vending_machine.treasury)]
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    let clock = Clock::get()?;
    let session = &mut ctx.accounts.spin_session;

    // Refund unlocks if dispenser failed to attest before timeout
    require!(
        clock.slot > session.request_slot.saturating_add(DISPENSER_TIMEOUT_SLOTS),
        VendingError::GracePeriodActive
    );

    session.status = SpinStatus::FaultRefunded;

    // Refund user directly from treasury via lamport balance adjustment
    let refund_amount = ctx.accounts.vending_machine.spin_price;

    **ctx.accounts.treasury.try_borrow_mut_lamports()? = ctx
        .accounts
        .treasury
        .lamports()
        .checked_sub(refund_amount)
        .ok_or(VendingError::MathOverflow)?;

    **ctx.accounts.user.try_borrow_mut_lamports()? = ctx
        .accounts
        .user
        .lamports()
        .checked_add(refund_amount)
        .ok_or(VendingError::MathOverflow)?;

    Ok(())
}