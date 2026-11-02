use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::state::*;
use crate::errors::*;

#[derive(Accounts)]
pub struct RequestSpin<'info> {
    #[account(
        mut,
        seeds = [MACHINE_SEED, &machine.machine_id.to_le_bytes()],
        bump = machine.bump
    )]
    pub machine: Account<'info, VendingMachine>,

    #[account(
        init,
        payer = player,
        space = SpinSession::LEN,
        seeds = [
            SPIN_SEED,
            machine.key().as_ref(),
            player.key().as_ref(),
            &machine.total_spins_completed.to_le_bytes()
        ],
        bump
    )]
    pub spin_session: Account<'info, SpinSession>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestSpin>, user_commitment: [u8; 32]) -> Result<()> {
    let machine = &mut ctx.accounts.machine;
    require!(machine.is_active, VendingMachineError::MachineInactive);

    // Ensure at least one physical shelf has available stock
    let has_stock = machine.shelf_quantities.iter().any(|&q| q > 0);
    require!(has_stock, VendingMachineError::InventoryDepleted);

    // Transfer SOL cost of spin to the machine PDA
    let cpi_context = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        Transfer {
            from: ctx.accounts.player.to_account_info(),
            to: machine.to_account_info(),
        },
    );
    transfer(cpi_context, machine.cost_per_spin_lamports)?;

    let clock = Clock::get()?;
    let current_nonce = machine.total_spins_completed;

    let session = &mut ctx.accounts.spin_session;
    session.machine = machine.key();
    session.player = ctx.accounts.player.key();
    session.nonce = current_nonce;
    session.user_commitment = user_commitment;
    session.operator_seed = [0u8; 32];
    session.prize_tier = 0;
    session.allocated_shelf = 0;
    session.request_slot = clock.slot;
    session.resolved_slot = 0;
    session.status = SpinStatus::Committed;
    session.bump = ctx.bumps.spin_session;

    machine.active_spins_in_flight = machine.active_spins_in_flight
        .checked_add(1)
        .ok_or(VendingMachineError::MathOverflow)?;

    emit!(SpinRequestedEvent {
        machine_id: machine.machine_id,
        player: session.player,
        nonce: current_nonce,
        request_slot: clock.slot,
    });

    Ok(())
}