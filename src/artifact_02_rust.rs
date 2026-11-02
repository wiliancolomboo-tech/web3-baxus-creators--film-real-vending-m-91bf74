// programs/baxus-vending/src/lib.rs
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("BXSVnd9M2B6xR9k5WpUQc7T67hS7yH8zC2E8zK4kHwF");

pub const MAX_BOTTLES: usize = 32;
pub const TIMEOUT_SLOT_DELTA: u64 = 150; // ~60 seconds at 400ms slots

#[program]
pub mod baxus_vending {
    use super::*;

    /// Initializes a new physical vending machine instance with authorized keeper oracle.
    pub fn initialize_machine(
        ctx: Context<InitializeMachine>,
        machine_id: u64,
        dispense_fee: u64,
        keeper_authority: Pubkey,
    ) -> Result<()> {
        let machine = &mut ctx.accounts.machine;
        machine.authority = ctx.accounts.authority.key();
        machine.keeper_authority = keeper_authority;
        machine.payment_mint = ctx.accounts.payment_mint.key();
        machine.machine_id = machine_id;
        machine.dispense_fee = dispense_fee;
        machine.total_spins = 0;
        machine.active_inventory_count = 0;
        machine.bump = ctx.bumps.machine;
        machine.escrow_bump = ctx.bumps.escrow_vault;

        emit!(MachineInitializedEvent {
            machine_id,
            authority: machine.authority,
            keeper_authority,
            dispense_fee,
        });

        Ok(())
    }

    /// Register a physical RWA bottle asset into the vending inventory slot.
    pub fn register_bottle(
        ctx: Context<RegisterBottle>,
        slot_index: u8,
        bottle_sku: [u8; 16],
        bottle_tier: u8,
    ) -> Result<()> {
        require!(slot_index < MAX_BOTTLES as u8, VendingError::InvalidSlotIndex);
        
        let bottle = &mut ctx.accounts.bottle_slot;
        bottle.machine = ctx.accounts.machine.key();
        bottle.slot_index = slot_index;
        bottle.bottle_sku = bottle_sku;
        bottle.bottle_tier = bottle_tier;
        bottle.is_available = true;
        bottle.bump = ctx.bumps.bottle_slot;

        let machine = &mut ctx.accounts.machine;
        machine.active_inventory_count = machine.active_inventory_count.checked_add(1).ok_or(VendingError::ArithmeticOverflow)?;

        emit!(BottleRegisteredEvent {
            machine_id: machine.machine_id,
            slot_index,
            bottle_sku,
            bottle_tier,
        });

        Ok(())
    }

    /// User initiates spin: locks fee, computes pseudo-random seed, creates active spin session.
    pub fn initiate_spin(
        ctx: Context<InitiateSpin>,
        user_entropy: [u8; 32],
    ) -> Result<()> {
        let machine = &mut ctx.accounts.machine;
        require!(machine.active_inventory_count > 0, VendingError::OutOfStock);

        // Secure transfer of payment from User to Escrow PDA
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, machine.dispense_fee)?;

        let session = &mut ctx.accounts.spin_session;
        let clock = Clock::get()?;

        session.machine = machine.key();
        session.user = ctx.accounts.user.key();
        session.session_id = machine.total_spins;
        session.initiated_slot = clock.slot;
        session.status = SpinStatus::PendingPhysicalDispense;
        session.bump = ctx.bumps.spin_session;

        // Entropy derivation combining user seed, slot clock, slot hashes, and session counter
        let mut seed_material = Vec::with_capacity(72);
        seed_material.extend_from_slice(&user_entropy);
        seed_material.extend_from_slice(&clock.slot.to_le_bytes());
        seed_material.extend_from_slice(&clock.unix_timestamp.to_le_bytes());
        seed_material.extend_from_slice(&machine.total_spins.to_le_bytes());
        
        let spin_entropy_hash = anchor_lang::solana_program::hash::hash(&seed_material);
        session.randomness_digest = spin_entropy_hash.to_bytes();

        machine.total_spins = machine.total_spins.checked_add(1).ok_or(VendingError::ArithmeticOverflow)?;

        emit!(SpinInitiatedEvent {
            machine_id: machine.machine_id,
            session_id: session.session_id,
            user: session.user,
            slot: clock.slot,
            randomness_digest: session.randomness_digest,
        });

        Ok(())
    }

    /// Hardware Keeper verifies drop sensor, links filmed video hash, and completes dispense.
    pub fn confirm_dispense(
        ctx: Context<ConfirmDispense>,
        slot_index: u8,
        video_hash: [u8; 32],
        ipfs_cid: [u8; 46],
        telemetry_ir_pulse_count: u32,
    ) -> Result<()> {
        let machine = &mut ctx.accounts.machine;
        let session = &mut ctx.accounts.spin_session;
        let bottle = &mut ctx.accounts.bottle_slot;

        require_keys_eq!(ctx.accounts.keeper.key(), machine.keeper_authority, VendingError::UnauthorizedKeeper);
        require!(session.status == SpinStatus::PendingPhysicalDispense, VendingError::InvalidSessionState);
        require!(bottle.is_available, VendingError::BottleUnavailable);
        require!(telemetry_ir_pulse_count > 0, VendingError::HardwareDropNotDetected);

        // Update Bottle State
        bottle.is_available = false;
        machine.active_inventory_count = machine.active_inventory_count.checked_sub(1).ok_or(VendingError::ArithmeticOverflow)?;

        // Update Session State with Film and Telemetry Attestation
        session.status = SpinStatus::DispensedSuccessfully;
        session.selected_slot_index = slot_index;
        session.video_hash = video_hash;
        session.ipfs_cid = ipfs_cid;
        session.dispensed_slot = Clock::get()?.slot;

        // Route escrow funds to treasury
        let machine_id_bytes = machine.machine_id.to_le_bytes();
        let escrow_seeds = &[
            b"escrow".as_ref(),
            machine_id_bytes.as_ref(),
            &[machine.escrow_bump],
        ];
        let signer_seeds = &[&escrow_seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, machine.dispense_fee)?;

        emit!(DispenseConfirmedEvent {
            machine_id: machine.machine_id,
            session_id: session.session_id,
            slot_index,
            video_hash,
            ipfs_cid,
        });

        Ok(())
    }

    /// User or Keeper can cancel and refund if the hardware fails to dispense within TIMEOUT_SLOT_DELTA.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let machine = &ctx.accounts.machine;
        let session = &mut ctx.accounts.spin_session;
        let clock = Clock::get()?;

        require!(session.status == SpinStatus::PendingPhysicalDispense, VendingError::InvalidSessionState);
        require!(
            clock.slot >= session.initiated_slot.checked_add(TIMEOUT_SLOT_DELTA).ok_or(VendingError::ArithmeticOverflow)?,
            VendingError::TimeoutNotReached
        );

        session.status = SpinStatus::Refunded;

        let machine_id_bytes = machine.machine_id.to_le_bytes();
        let escrow_seeds = &[
            b"escrow".as_ref(),
            machine_id_bytes.as_ref(),
            &[machine.escrow_bump],
        ];
        let signer_seeds = &[&escrow_seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, machine.dispense_fee)?;

        emit!(SessionRefundedEvent {
            machine_id: machine.machine_id,
            session_id: session.session_id,
            user: session.user,
        });

        Ok(())
    }
}

// ----------------------------------------------------------------------------
// ACCOUNTS & INSTRUCTION STRUCTS
// ----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(machine_id: u64)]
pub struct InitializeMachine<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + VendingMachine::INIT_SPACE,
        seeds = [b"machine", machine_id.to_le_bytes().as_ref()],
        bump
    )]
    pub machine: Account<'info, VendingMachine>,
    
    pub payment_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"escrow", machine_id.to_le_bytes().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = escrow_vault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(slot_index: u8)]
pub struct RegisterBottle<'info> {
    #[account(
        mut,
        has_one = authority @ VendingError::UnauthorizedOwner
    )]
    pub machine: Account<'info, VendingMachine>,

    #[account(
        init,
        payer = authority,
        space = 8 + BottleSlot::INIT_SPACE,
        seeds = [b"bottle", machine.key().as_ref(), &[slot_index]],
        bump
    )]
    pub bottle_slot: Account<'info, BottleSlot>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitiateSpin<'info> {
    #[account(mut)]
    pub machine: Account<'info, VendingMachine>,

    #[account(
        init,
        payer = user,
        space = 8 + SpinSession::INIT_SPACE,
        seeds = [b"session", machine.key().as_ref(), machine.total_spins.to_le_bytes().as_ref()],
        bump
    )]
    pub spin_session: Account<'info, SpinSession>,

    #[account(
        mut,
        seeds = [b"escrow", machine.machine_id.to_le_bytes().as_ref()],
        bump = machine.escrow_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ VendingError::InvalidTokenOwner,
        constraint = user_token_account.mint == machine.payment_mint @ VendingError::InvalidMint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(slot_index: u8)]
pub struct ConfirmDispense<'info> {
    #[account(mut)]
    pub machine: Account<'info, VendingMachine>,

    #[account(
        mut,
        seeds = [b"session", machine.key().as_ref(), spin_session.session_id.to_le_bytes().as_ref()],
        bump = spin_session.bump,
        has_one = machine @ VendingError::MachineMismatch
    )]
    pub spin_session: Account<'info, SpinSession>,

    #[account(
        mut,
        seeds = [b"bottle", machine.key().as_ref(), &[slot_index]],
        bump = bottle_slot.bump,
        has_one = machine @ VendingError::MachineMismatch
    )]
    pub bottle_slot: Account<'info, BottleSlot>,

    #[account(
        mut,
        seeds = [b"escrow", machine.machine_id.to_le_bytes().as_ref()],
        bump = machine.escrow_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.mint == machine.payment_mint @ VendingError::InvalidMint
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub keeper: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    pub machine: Account<'info, VendingMachine>,

    #[account(
        mut,
        seeds = [b"session", machine.key().as_ref(), spin_session.session_id.to_le_bytes().as_ref()],
        bump = spin_session.bump,
        has_one = machine @ VendingError::MachineMismatch,
        constraint = spin_session.user == user.key() @ VendingError::UnauthorizedRefundSigner
    )]
    pub spin_session: Account<'info, SpinSession>,

    #[account(
        mut,
        seeds = [b"escrow", machine.machine_id.to_le_bytes().as_ref()],
        bump = machine.escrow_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ VendingError::InvalidTokenOwner,
        constraint = user_token_account.mint == machine.payment_mint @ VendingError::InvalidMint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ----------------------------------------------------------------------------
// DATA STRUCTURES
// ----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct VendingMachine {
    pub authority: Pubkey,         // 32
    pub keeper_authority: Pubkey,  // 32
    pub payment_mint: Pubkey,      // 32
    pub machine_id: u64,           // 8
    pub dispense_fee: u64,         // 8
    pub total_spins: u64,          // 8
    pub active_inventory_count: u16,// 2
    pub bump: u8,                  // 1
    pub escrow_bump: u8,           // 1
}

#[account]
#[derive(InitSpace)]
pub struct BottleSlot {
    pub machine: Pubkey,           // 32
    pub bottle_sku: [u8; 16],      // 16 (BAXUS Asset ID)
    pub slot_index: u8,            // 1
    pub bottle_tier: u8,           // 1 (e.g. 1=Rare, 2=Epic, 3=Grail)
    pub is_available: bool,        // 1
    pub bump: u8,                  // 1
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SpinStatus {
    PendingPhysicalDispense,
    DispensedSuccessfully,
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct SpinSession {
    pub machine: Pubkey,           // 32
    pub user: Pubkey,              // 32
    pub session_id: u64,           // 8
    pub initiated_slot: u64,       // 8
    pub dispensed_slot: u64,       // 8
    pub randomness_digest: [u8; 32],// 32
    pub video_hash: [u8; 32],      // 32 (SHA-256 of Creator's filmed MP4)
    pub ipfs_cid: [u8; 46],        // 46 (IPFS multihash string bytes)
    pub status: SpinStatus,        // 1 + 1
    pub selected_slot_index: u8,   // 1
    pub bump: u8,                  // 1
}

// ----------------------------------------------------------------------------
// EVENTS & ERRORS
// ----------------------------------------------------------------------------

#[event]
pub struct MachineInitializedEvent {
    pub machine_id: u64,
    pub authority: Pubkey,
    pub keeper_authority: Pubkey,
    pub dispense_fee: u64,
}

#[event]
pub struct BottleRegisteredEvent {
    pub machine_id: u64,
    pub slot_index: u8,
    pub bottle_sku: [u8; 16],
    pub bottle_tier: u8,
}

#[event]
pub struct SpinInitiatedEvent {
    pub machine_id: u64,
    pub session_id: u64,
    pub user: Pubkey,
    pub slot: u64,
    pub randomness_digest: [u8; 32],
}

#[event]
pub struct DispenseConfirmedEvent {
    pub machine_id: u64,
    pub session_id: u64,
    pub slot_index: u8,
    pub video_hash: [u8; 32],
    pub ipfs_cid: [u8; 46],
}

#[event]
pub struct SessionRefundedEvent {
    pub machine_id: u64,
    pub session_id: u64,
    pub user: Pubkey,
}

#[error_code]
pub enum VendingError {
    #[msg("Invalid slot index. Must be < MAX_BOTTLES.")]
    InvalidSlotIndex,
    #[msg("Vending machine inventory is depleted.")]
    OutOfStock,
    #[msg("Caller is not the authorized keeper hardware oracle.")]
    UnauthorizedKeeper,
    #[msg("Caller is not authorized vending machine authority.")]
    UnauthorizedOwner,
    #[msg("Session is not in PendingPhysicalDispense status.")]
    InvalidSessionState,
    #[msg("Selected bottle slot is already empty.")]
    BottleUnavailable,
    #[msg("Hardware did not register optoelectronic drop sensor trigger.")]
    HardwareDropNotDetected,
    #[msg("Timeout delta has not elapsed yet.")]
    TimeoutNotReached,
    #[msg("Unauthorized signer attempting to trigger user refund.")]
    UnauthorizedRefundSigner,
    #[msg("Associated token accounts owner check failed.")]
    InvalidTokenOwner,
    #[msg("Associated token accounts mint check failed.")]
    InvalidMint,
    #[msg("Account machine key mismatch.")]
    MachineMismatch,
    #[msg("Safe arithmetic overflow occurred.")]
    ArithmeticOverflow,
}