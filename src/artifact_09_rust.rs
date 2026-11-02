use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use crate::state::*;
use crate::errors::*;

#[derive(Accounts)]
pub struct ResolveSpin<'info> {
    #[account(
        mut,
        seeds = [MACHINE_SEED, &machine.machine_id.to_le_bytes()],
        bump = machine.bump,
        has_one = authority @ VendingMachineError::UnauthorizedHardwareAuthority
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

    pub authority: Signer<'info>,

    /// CHECK: Instructions sysvar for intra-transaction hash validation
    pub recent_blockhashes: Sysvar<'info, RecentBlockhashes>,
}

pub fn handler(
    ctx: Context<ResolveSpin>,
    operator_seed: [u8; 32],
    user_preimage: [u8; 32],
) -> Result<()> {
    let session = &mut ctx.accounts.spin_session;
    let machine = &mut ctx.accounts.machine;
    let clock = Clock::get()?;

    require!(
        session.status == SpinStatus::Committed,
        VendingMachineError::InvalidSpinStatus
    );

    // Enforce at least 1 slot gap to prevent flash-loan/same-slot reentrancy
    require!(
        clock.slot > session.request_slot,
        VendingMachineError::InvalidResolutionWindow
    );

    // Verify User Commitment Preimage: SHA256(user_preimage) == user_commitment
    let computed_hash = anchor_lang::solana_program::hash::hash(&user_preimage);
    require!(
        computed_hash.to_bytes() == session.user_commitment,
        VendingMachineError::InvalidPreimageReveal
    );

    // Entropy combining: SHA256(operator_seed || user_preimage || slot_hash)
    let entropy_hash = hashv(&[
        &operator_seed,
        &user_preimage,
        &clock.slot.to_le_bytes(),
    ]);
    let entropy_bytes = entropy_hash.to_bytes();
    let random_value = u32::from_le_bytes([
        entropy_bytes[0],
        entropy_bytes[1],
        entropy_bytes[2],
        entropy_bytes[3],
    ]);

    // Calculate prize tier based on distribution table (0-9999 basis points)
    // 80% Standard (0..7999), 15% Premium (8000..9499), 4.5% Ultra Rare (9500..9949), 0.5% Grand Reserve (9950..9999)
    let roll_bps = (random_value % 10_000) as u16;
    let desired_tier = if roll_bps >= 9950 {
        PrizeTier::GrandReserveDecanter
    } else if roll_bps >= 9500 {
        PrizeTier::UltraRareWhisky
    } else if roll_bps >= 8000 {
        PrizeTier::PremiumBourbon
    } else {
        PrizeTier::StandardCraft
    };

    // Find available shelf holding the target tier, or fallback to lowest tier in stock
    let mut selected_shelf: Option<usize> = None;

    for (i, &qty) in machine.shelf_quantities.iter().enumerate() {
        if i >= machine.max_shelves as usize {
            break;
        }
        if qty > 0 && machine.shelf_tiers[i] == (desired_tier as u8) {
            selected_shelf = Some(i);
            break;
        }
    }

    // Fallback: pick any shelf with stock if desired tier is depleted
    if selected_shelf.is_none() {
        for (i, &qty) in machine.shelf_quantities.iter().enumerate() {
            if i >= machine.max_shelves as usize {
                break;
            }
            if qty > 0 {
                selected_shelf = Some(i);
                break;
            }
        }
    }

    let final_shelf = selected_shelf.ok_or(VendingMachineError::InventoryDepleted)?;

    // Lock shelf assignment and mark ready for mechanical drop
    session.operator_seed = operator_seed;
    session.prize_tier = machine.shelf_tiers[final_shelf];
    session.allocated_shelf = final_shelf as u8;
    session.resolved_slot = clock.slot;
    session.status = SpinStatus::ResolvedWaitingDispense;

    emit!(SpinSettledEvent {
        machine_id: machine.machine_id,
        player: session.player,
        nonce: session.nonce,
        prize_tier: session.prize_tier,
        shelf_id: final_shelf as u8,
    });

    Ok(())
}