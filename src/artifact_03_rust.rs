use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::hash::hash;

declare_id!("BXSVnd1111111111111111111111111111111111111");

pub const MAX_SLOTS: u8 = 32;
pub const DISPENSE_TIMEOUT_SECONDS: i64 = 180; // 3-minute physical drop window

#[program]
pub mod baxus_vending {
    use super::*;

    /// Initializes a physical machine profile on-chain with its TPM/hardware pubkey.
    pub fn initialize_machine(
        ctx: Context<InitializeMachine>,
        machine_id: [u8; 16],
        price_per_spin: u64,
        dispense_timeout: i64,
    ) -> Result<()> {
        let machine = &mut ctx.accounts.machine_state;
        machine.admin = ctx.accounts.admin.key();
        machine.hardware_signer = ctx.accounts.hardware_signer.key();
        machine.machine_id = machine_id;
        machine.payment_mint = ctx.accounts.payment_mint.key();
        machine.price_per_spin = price_per_spin;
        machine.dispense_timeout = if dispense_timeout > 0 {
            dispense_timeout
        } else {
            DISPENSE_TIMEOUT_SECONDS
        };
        machine.total_spins = 0;
        machine.active_slots = 0;
        machine.is_paused = false;
        machine.bump = ctx.bumps.machine_state;
        machine.escrow_bump = ctx.bumps.escrow_vault;

        emit!(MachineInitializedEvent {
            machine_id,
            admin: machine.admin,
            hardware_signer: machine.hardware_signer,
            price_per_spin,
        });

        Ok(())
    }

    /// Stocks a physical slot with corresponding bottle metadata and weight for probability.
    pub fn stock_inventory_slot(
        ctx: Context<StockInventorySlot>,
        slot_id: u8,
        quantity: u16,
        weight_bps: u16,
        rwa_asset_id: [u8; 32],
        tier: u8,
    ) -> Result<()> {
        require!(slot_id < MAX_SLOTS, VendingError::InvalidSlotId);
        require!(weight_bps > 0, VendingError::ZeroWeight);

        let slot = &mut ctx.accounts.inventory_slot;
        slot.machine = ctx.accounts.machine_state.key();
        slot.slot_id = slot_id;
        slot.remaining_stock = quantity;
        slot.total_capacity = quantity;
        slot.weight_bps = weight_bps;
        slot.rwa_asset_id = rwa_asset_id;
        slot.tier = tier;
        slot.bump = ctx.bumps.inventory_slot;

        let machine = &mut ctx.accounts.machine_state;
        if slot.remaining_stock > 0 {
            machine.active_slots = machine.active_slots.max(slot_id + 1);
        }

        emit!(SlotStockedEvent {
            machine_id: machine.machine_id,
            slot_id,
            quantity,
            weight_bps,
            tier,
        });

        Ok(())
    }

    /// Phase 1: User commits to a spin, pays USDC into escrow, stores user commit hash.
    pub fn commit_spin(
        ctx: Context<CommitSpin>,
        user_commitment: [u8; 32],
    ) -> Result<()> {
        let machine = &ctx.accounts.machine_state;
        require!(!machine.is_paused, VendingError::MachinePaused);

        // Deduct spin cost from user to machine escrow
        let transfer_cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_cpi, machine.price_per_spin)?;

        let machine_mut = &mut ctx.accounts.machine_state;
        let spin_ticket = &mut ctx.accounts.spin_ticket;
        let clock = Clock::get()?;

        spin_ticket.machine = machine_mut.key();
        spin_ticket.spin_index = machine_mut.total_spins;
        spin_ticket.user = ctx.accounts.user.key();
        spin_ticket.commitment = user_commitment;
        spin_ticket.committed_slot = clock.slot;
        spin_ticket.committed_timestamp = clock.unix_timestamp;
        spin_ticket.status = SpinStatus::Committed;
        spin_ticket.won_slot = 0;
        spin_ticket.bump = ctx.bumps.spin_ticket;

        machine_mut.total_spins = machine_mut.total_spins.checked_add(1).unwrap();

        emit!(SpinCommittedEvent {
            machine_id: machine_mut.machine_id,
            spin_index: spin_ticket.spin_index,
            user: spin_ticket.user,
            commitment: user_commitment,
            slot: clock.slot,
        });

        Ok(())
    }

    /// Phase 2: User reveals secret; randomness resolves winning bottle tier.
    pub fn settle_spin<'info>(
        ctx: Context<'_, '_, '_, 'info, SettleSpin<'info>>,
        reveal_secret: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let spin_ticket = &mut ctx.accounts.spin_ticket;
        
        require!(spin_ticket.status == SpinStatus::Committed, VendingError::InvalidSpinStatus);
        require!(clock.slot > spin_ticket.committed_slot, VendingError::RevealInSameSlot);
        require!(
            clock.slot <= spin_ticket.committed_slot + 250,
            VendingError::RevealExpired
        );

        // Verify reveal matches commitment
        let derived_hash = hash(&reveal_secret).to_bytes();
        require!(derived_hash == spin_ticket.commitment, VendingError::HashMismatch);

        // Combine user secret + committed slot + blockhash entropy
        let mut entropy_input = Vec::with_capacity(32 + 8 + 32);
        entropy_input.extend_from_slice(&reveal_secret);
        entropy_input.extend_from_slice(&spin_ticket.committed_slot.to_le_bytes());
        entropy_input.extend_from_slice(ctx.accounts.recent_slothashes.data.borrow().get(0..32).unwrap_or(&[7u8; 32]));
        
        let final_randomness = hash(&entropy_input).to_bytes();
        let random_value = u32::from_le_bytes(final_randomness[0..4].try_into().unwrap());

        // Select winning slot based on weights of remaining stock
        let mut total_weight: u32 = 0;
        let mut loaded_slots: Vec<Account<InventorySlot>> = Vec::new();

        for acc in ctx.remaining_accounts.iter() {
            let slot_acc: Account<InventorySlot> = Account::try_from(acc)?;
            if slot_acc.remaining_stock > 0 {
                total_weight += slot_acc.weight_bps as u32;
            }
            loaded_slots.push(slot_acc);
        }

        require!(total_weight > 0, VendingError::OutOfStock);

        let mut roll = (random_value % total_weight) as i32;
        let mut selected_slot_id: u8 = 0;
        let mut selected_rwa_id: [u8; 32] = [0u8; 32];
        let mut selected_tier: u8 = 0;

        for slot in loaded_slots.iter() {
            if slot.remaining_stock == 0 {
                continue;
            }
            roll -= slot.weight_bps as i32;
            if roll < 0 {
                selected_slot_id = slot.slot_id;
                selected_rwa_id = slot.rwa_asset_id;
                selected_tier = slot.tier;
                break;
            }
        }

        // Decrement physical inventory
        let slot_account_info = ctx.remaining_accounts
            .iter()
            .find(|acc| acc.key().to_bytes()[..] != [0u8; 0])
            .ok_or(VendingError::SlotNotFound)?;
            
        let mut target_slot: Account<InventorySlot> = Account::try_from(slot_account_info)?;
        require!(target_slot.slot_id == selected_slot_id, VendingError::SlotMismatch);
        target_slot.remaining_stock = target_slot.remaining_stock.checked_sub(1).unwrap();
        target_slot.exit(ctx.program_id)?;

        // Update spin ticket
        spin_ticket.status = SpinStatus::SettledAwaitingDispense;
        spin_ticket.won_slot = selected_slot_id;
        spin_ticket.settled_timestamp = clock.unix_timestamp;

        emit!(SpinSettledEvent {
            machine_id: ctx.accounts.machine_state.machine_id,
            spin_index: spin_ticket.spin_index,
            user: spin_ticket.user,
            slot_id: selected_slot_id,
            rwa_asset_id: selected_rwa_id,
            tier: selected_tier,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Phase 3: Hardware dispenser confirms physical drop via IR optical sensor.
    pub fn confirm_dispense(
        ctx: Context<ConfirmDispense>,
        hardware_telemetry_hash: [u8; 32],
    ) -> Result<()> {
        let spin_ticket = &mut ctx.accounts.spin_ticket;
        require!(
            spin_ticket.status == SpinStatus::SettledAwaitingDispense,
            VendingError::InvalidSpinStatus
        );

        let clock = Clock::get()?;
        let machine = &ctx.accounts.machine_state;

        // Verify dispense window has not expired
        require!(
            clock.unix_timestamp <= spin_ticket.settled_timestamp + machine.dispense_timeout,
            VendingError::DispenseTimeoutExceeded
        );

        spin_ticket.status = SpinStatus::DispensedSuccessfully;
        spin_ticket.telemetry_proof = hardware_telemetry_hash;

        emit!(DispenseConfirmedEvent {
            machine_id: machine.machine_id,
            spin_index: spin_ticket.spin_index,
            user: spin_ticket.user,
            slot_id: spin_ticket.won_slot,
            telemetry_proof: hardware_telemetry_hash,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Emergency refund if machine coils jam or optical sensor detects no drop.
    pub fn emergency_refund_timeout(ctx: Context<EmergencyRefund>) -> Result<()> {
        let spin_ticket = &mut ctx.accounts.spin_ticket;
        let machine = &ctx.accounts.machine_state;
        let clock = Clock::get()?;

        require!(
            spin_ticket.status == SpinStatus::SettledAwaitingDispense,
            VendingError::InvalidSpinStatus
        );
        require!(
            clock.unix_timestamp > spin_ticket.settled_timestamp + machine.dispense_timeout,
            VendingError::DispenseWindowActive
        );

        spin_ticket.status = SpinStatus::RefundedDueToHardwareFailure;

        // Transfer funds back from escrow PDA to user
        let machine_id_bytes = machine.machine_id;
        let bump = machine.escrow_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            machine_id_bytes.as_ref(),
            &[bump],
        ]];

        let transfer_cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_cpi, machine.price_per_spin)?;

        emit!(EmergencyRefundEvent {
            machine_id: machine.machine_id,
            spin_index: spin_ticket.spin_index,
            user: spin_ticket.user,
            refund_amount: machine.price_per_spin,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(machine_id: [u8; 16])]
pub struct InitializeMachine<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Hardware machine TPM public key
    pub hardware_signer: AccountInfo<'info>,
    pub payment_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + MachineState::LEN,
        seeds = [b"machine", machine_id.as_ref()],
        bump
    )]
    pub machine_state: Account<'info, MachineState>,

    #[account(
        init,
        payer = admin,
        seeds = [b"escrow", machine_id.as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = escrow_vault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(slot_id: u8)]
pub struct StockInventorySlot<'info> {
    #[account(mut, has_one = admin @ VendingError::UnauthorizedAdmin)]
    pub machine_state: Account<'info, MachineState>,
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + InventorySlot::LEN,
        seeds = [b"inventory", machine_state.key().as_ref(), &[slot_id]],
        bump
    )]
    pub inventory_slot: Account<'info, InventorySlot>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitSpin<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"machine", machine_state.machine_id.as_ref()],
        bump = machine_state.bump
    )]
    pub machine_state: Account<'info, MachineState>,

    #[account(
        mut,
        seeds = [b"escrow", machine_state.machine_id.as_ref()],
        bump = machine_state.escrow_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ VendingError::InvalidTokenOwner,
        constraint = user_token_account.mint == machine_state.payment_mint @ VendingError::InvalidTokenMint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        space = 8 + SpinTicket::LEN,
        seeds = [b"spin", machine_state.key().as_ref(), &machine_state.total_spins.to_le_bytes()],
        bump
    )]
    pub spin_ticket: Account<'info, SpinTicket>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleSpin<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"machine", machine_state.machine_id.as_ref()],
        bump = machine_state.bump
    )]
    pub machine_state: Account<'info, MachineState>,

    #[account(
        mut,
        seeds = [b"spin", machine_state.key().as_ref(), &spin_ticket.spin_index.to_le_bytes()],
        bump = spin_ticket.bump,
        has_one = user @ VendingError::UnauthorizedUser
    )]
    pub spin_ticket: Account<'info, SpinTicket>,

    /// CHECK: Solana Recent SlotHashes Sysvar (Address: SysvarS1otHashes111111111111111111111111111)
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub recent_slothashes: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ConfirmDispense<'info> {
    #[account(
        constraint = hardware_signer.key() == machine_state.hardware_signer @ VendingError::UnauthorizedHardware
    )]
    pub hardware_signer: Signer<'info>,

    #[account(
        seeds = [b"machine", machine_state.machine_id.as_ref()],
        bump = machine_state.bump
    )]
    pub machine_state: Account<'info, MachineState>,

    #[account(
        mut,
        seeds = [b"spin", machine_state.key().as_ref(), &spin_ticket.spin_index.to_le_bytes()],
        bump = spin_ticket.bump
    )]
    pub spin_ticket: Account<'info, SpinTicket>,
}

#[derive(Accounts)]
pub struct EmergencyRefund<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [b"machine", machine_state.machine_id.as_ref()],
        bump = machine_state.bump
    )]
    pub machine_state: Account<'info, MachineState>,

    #[account(
        mut,
        seeds = [b"escrow", machine_state.machine_id.as_ref()],
        bump = machine_state.escrow_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"spin", machine_state.key().as_ref(), &spin_ticket.spin_index.to_le_bytes()],
        bump = spin_ticket.bump
    )]
    pub spin_ticket: Account<'info, SpinTicket>,

    #[account(
        mut,
        constraint = user_token_account.owner == spin_ticket.user @ VendingError::InvalidTokenOwner
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// State Structs
// -----------------------------------------------------------------------------

#[account]
pub struct MachineState {
    pub admin: Pubkey,
    pub hardware_signer: Pubkey,
    pub payment_mint: Pubkey,
    pub machine_id: [u8; 16],
    pub price_per_spin: u64,
    pub total_spins: u64,
    pub dispense_timeout: i64,
    pub active_slots: u8,
    pub is_paused: bool,
    pub bump: u8,
    pub escrow_bump: u8,
}

impl MachineState {
    pub const LEN: usize = 32 + 32 + 32 + 16 + 8 + 8 + 8 + 1 + 1 + 1 + 1;
}

#[account]
pub struct InventorySlot {
    pub machine: Pubkey,
    pub slot_id: u8,
    pub remaining_stock: u16,
    pub total_capacity: u16,
    pub weight_bps: u16,
    pub rwa_asset_id: [u8; 32],
    pub tier: u8,
    pub bump: u8,
}

impl InventorySlot {
    pub const LEN: usize = 32 + 1 + 2 + 2 + 2 + 32 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SpinStatus {
    Committed,
    SettledAwaitingDispense,
    DispensedSuccessfully,
    RefundedDueToHardwareFailure,
}

#[account]
pub struct SpinTicket {
    pub machine: Pubkey,
    pub user: Pubkey,
    pub spin_index: u64,
    pub commitment: [u8; 32],
    pub committed_slot: u64,
    pub committed_timestamp: i64,
    pub settled_timestamp: i64,
    pub won_slot: u8,
    pub status: SpinStatus,
    pub telemetry_proof: [u8; 32],
    pub bump: u8,
}

impl SpinTicket {
    pub const LEN: usize = 32 + 32 + 8 + 32 + 8 + 8 + 8 + 1 + 1 + 32 + 1;
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------

#[event]
pub struct MachineInitializedEvent {
    pub machine_id: [u8; 16],
    pub admin: Pubkey,
    pub hardware_signer: Pubkey,
    pub price_per_spin: u64,
}

#[event]
pub struct SlotStockedEvent {
    pub machine_id: [u8; 16],
    pub slot_id: u8,
    pub quantity: u16,
    pub weight_bps: u16,
    pub tier: u8,
}

#[event]
pub struct SpinCommittedEvent {
    pub machine_id: [u8; 16],
    pub spin_index: u64,
    pub user: Pubkey,
    pub commitment: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct SpinSettledEvent {
    pub machine_id: [u8; 16],
    pub spin_index: u64,
    pub user: Pubkey,
    pub slot_id: u8,
    pub rwa_asset_id: [u8; 32],
    pub tier: u8,
    pub timestamp: i64,
}

#[event]
pub struct DispenseConfirmedEvent {
    pub machine_id: [u8; 16],
    pub spin_index: u64,
    pub user: Pubkey,
    pub slot_id: u8,
    pub telemetry_proof: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct EmergencyRefundEvent {
    pub machine_id: [u8; 16],
    pub spin_index: u64,
    pub user: Pubkey,
    pub refund_amount: u64,
}

#[error_code]
pub enum VendingError {
    #[msg("Slot ID exceeds maximum allowed bounds.")]
    InvalidSlotId,
    #[msg("Inventory weight must be greater than zero.")]
    ZeroWeight,
    #[msg("Machine is currently paused.")]
    MachinePaused,
    #[msg("Unauthorized admin authority.")]
    UnauthorizedAdmin,
    #[msg("Unauthorized hardware authority.")]
    UnauthorizedHardware,
    #[msg("Unauthorized user signer.")]
    UnauthorizedUser,
    #[msg("Invalid token owner.")]
    InvalidTokenOwner,
    #[msg("Invalid token mint.")]
    InvalidTokenMint,
    #[msg("Invalid spin status for this transition.")]
    InvalidSpinStatus,
    #[msg("Cannot reveal in the same slot as commit.")]
    RevealInSameSlot,
    #[msg("Reveal period expired. Must settle within 250 slots.")]
    RevealExpired,
    #[msg("Reveal secret does not match committed hash.")]
    HashMismatch,
    #[msg("Machine is completely out of stock.")]
    OutOfStock,
    #[msg("Target inventory slot not found in accounts.")]
    SlotNotFound,
    #[msg("Slot account mismatch during resolution.")]
    SlotMismatch,
    #[msg("Physical dispense timeout has expired.")]
    DispenseTimeoutExceeded,
    #[msg("Physical dispense window is still active; cannot refund yet.")]
    DispenseWindowActive,
}