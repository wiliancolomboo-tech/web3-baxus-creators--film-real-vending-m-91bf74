use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::*;

#[derive(Accounts)]
pub struct ConfirmPhysicalDispense<'info> {
    #[account(
        mut,
        seeds = [MACHINE_SEED, &machine.machine_id.to_le_bytes()],
        bump = machine.bump,
        has_one = hardware_key @ VendingMachineError::UnauthorizedHardwareAuthority
    )]
    pub machine: Account<'info, VendingMachine>,

    #[account(
        mut,
        seeds = [
            SPIN_SEED,
            machine.key().as_ref(),
            spin_session.player.as_ref(),
            &spin_session.nonce.to_le_bytes()
        ],
        bump = spin_session.bump
    )]
    pub spin_session: Account<'info, SpinSession>,

    /// The physical embedded IoT controller signer
    pub hardware_key: Signer<'info>,
}

pub fn handler(
    ctx: Context<ConfirmPhysicalDispense>,
    _hardware_signature: [u8; 64],
) -> Result<()> {
    let machine = &mut ctx.accounts.machine;
    let session = &mut ctx.accounts.spin_session;

    require!(
        session.status == SpinStatus::ResolvedWaitingDispense,
        VendingMachineError::InvalidSpinStatus
    );

    let shelf_idx = session.allocated_shelf as usize;
    require!(
        machine.shelf_quantities[shelf_idx] > 0,
        VendingMachineError::ShelfOutOfStock
    );

    // Decrement physical inventory
    machine.shelf_quantities[shelf_idx] = machine.shelf_quantities[shelf_idx]
        .checked_sub(1)
        .ok_or(VendingMachineError::MathOverflow)?;

    machine.active_spins_in_flight = machine.active_spins_in_flight
        .checked_sub(1)
        .ok_or(VendingMachineError::MathOverflow)?;

    machine.total_spins_completed = machine.total_spins_completed
        .checked_add(1)
        .ok_or(VendingMachineError::MathOverflow)?;

    session.status = SpinStatus::Dispensed;

    let clock = Clock::get()?;
    emit!(PhysicalDispenseCompletedEvent {
        machine_id: machine.machine_id,
        player: session.player,
        nonce: session.nonce,
        shelf_id: shelf_idx as u8,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Mechanical drop confirmed. Machine {} Nonce {} Shelf {}",
        machine.machine_id,
        session.nonce,
        shelf_idx
    );

    Ok(())
}