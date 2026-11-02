use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::hash::hashv;

declare_id!("BXSVnd1111111111111111111111111111111111111");

pub const MAX_SLOTS: usize = 16;
pub const SPIN_FEE_LAMPORTS: u64 = 50_000_000; // 0.05 SOL
pub const COMMIT_BLOCK_EXPIRATION: u64 = 150; // ~1 minute window

#[program]
pub mod baxus_vending {
    use super::*;

    /// Initializes a new physical vending machine registry
    pub fn initialize_machine(
        ctx: Context<InitializeMachine>,
        machine_id: u64,
        bump: u8,
    ) -> Result<()> {
        let machine = &mut ctx.accounts.machine;
        machine.admin = ctx.accounts.admin.key();
        machine.machine_id = machine_id;
        machine.total_spins = 0;
        machine.active_slots = 0;
        machine.is_active = true;
        machine.bump = bump;
        msg!("BAXUS Machine #{} initialized successfully.", machine_id);
        Ok(())
    }

    /// Configures or restocks a physical slot with bottle metadata and rarity weight
    pub fn configure_slot(
        ctx: Context<ConfigureSlot>,
        slot_id: u8,
        item_sku: [u8; 16],
        rarity_weight: u16,
        initial_stock: u16,
    ) -> Result<()> {
        require!((slot_id as usize) < MAX_SLOTS, VendingError::InvalidSlotId);
        require!(rarity_weight > 0, VendingError::ZeroWeightForbidden);

        let machine = &mut ctx.accounts.machine;
        let slot = &mut ctx.accounts.slot;

        slot.machine = machine.key();
        slot.slot_id = slot_id;
        slot.item_sku = item_sku;
        slot.rarity_weight = rarity_weight;
        slot.remaining_stock = initial_stock;
        slot.bump = ctx.bumps.slot;

        if slot.remaining_stock > 0 && !slot.is_configured {
            machine.active_slots = machine.active_slots.checked_add(1).unwrap();
            slot.is_configured = true;
        }

        msg!("Slot #{} configured with stock: {}", slot_id, initial_stock);
        Ok(())
    }

    /// User registers commitment to spin, escrowing fee and securing against frontrunning
    pub fn request_spin(
        ctx: Context<RequestSpin>,
        user_seed: [u8; 32],
    ) -> Result<()> {
        let machine = &ctx.accounts.machine;
        require!(machine.is_active, VendingError::MachineInactive);
        require!(machine.active_slots > 0, VendingError::MachineOutOfStock);

        // Deduct payment
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.user.key(),
            &ctx.accounts.treasury.key(),
            SPIN_FEE_LAMPORTS,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let spin = &mut ctx.accounts.spin_record;
        let clock = Clock::get()?;

        spin.user = ctx.accounts.user.key();
        spin.machine = machine.key();
        spin.user_seed = user_seed;
        spin.request_slot = clock.slot;
        spin.is_settled = false;
        spin.bump = ctx.bumps.spin_record;

        emit!(SpinRequestedEvent {
            user: spin.user,
            machine_id: machine.machine_id,
            request_slot: clock.slot,
        });

        Ok(())
    }

    /// Settles the spin deterministically using past recent blockhash and emits hardware telemetry
    pub fn settle_spin(
        ctx: Context<SettleSpin>,
        keeper_entropy: [u8; 32],
    ) -> Result<()> {
        let spin = &mut ctx.accounts.spin_record;
        let machine = &mut ctx.accounts.machine;
        let clock = Clock::get()?;

        require!(!spin.is_settled, VendingError::SpinAlreadySettled);
        require!(
            clock.slot > spin.request_slot,
            VendingError::BlockDelayNotMet
        );
        require!(
            clock.slot <= spin.request_slot + COMMIT_BLOCK_EXPIRATION,
            VendingError::SpinCommitmentExpired
        );

        // Deterministic Pseudo-Random Seed computation
        let combined_hash = hashv(&[
            &spin.user_seed,
            &keeper_entropy,
            &spin.user.to_bytes(),
            &spin.request_slot.to_le_bytes(),
        ]);
        let entropy_u64 = u64::from_le_bytes(combined_hash.to_bytes()[0..8].try_into().unwrap());

        // Select slot based on remaining stock and weight
        let slot = &mut ctx.accounts.slot;
        require!(slot.machine == machine.key(), VendingError::MachineMismatch);
        require!(slot.remaining_stock > 0, VendingError::SlotOutOfStock);

        // Decrement stock
        slot.remaining_stock = slot.remaining_stock.checked_sub(1).unwrap();
        if slot.remaining_stock == 0 {
            machine.active_slots = machine.active_slots.saturating_sub(1);
        }

        spin.is_settled = true;
        spin.settled_slot = clock.slot;
        spin.awarded_slot_id = slot.slot_id;
        machine.total_spins = machine.total_spins.checked_add(1).unwrap();

        // Emit Dispense Event for Hardware Relay daemon
        emit!(DispenseTelemetryEvent {
            machine_id: machine.machine_id,
            slot_id: slot.slot_id,
            item_sku: slot.item_sku,
            recipient: spin.user,
            spin_index: machine.total_spins,
            entropy_digest: combined_hash.to_bytes(),
            timestamp: clock.unix_timestamp,
        });

        msg!(
            "Dispensed bottle from Slot #{} to Recipient {}",
            slot.slot_id,
            spin.user
        );
        Ok(())
    }
}

// -------------------------
// Contexts & Account Models
// -------------------------

#[derive(Accounts)]
#[instruction(machine_id: u64, bump: u8)]
pub struct InitializeMachine<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + MachineAccount::INIT_SPACE,
        seeds = [b"baxus_machine", machine_id.to_le_bytes().as_ref()],
        bump
    )]
    pub machine: Account<'info, MachineAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(slot_id: u8)]
pub struct ConfigureSlot<'info> {
    #[account(
        mut,
        has_one = admin @ VendingError::UnauthorizedAdmin
    )]
    pub machine: Account<'info, MachineAccount>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + SlotAccount::INIT_SPACE,
        seeds = [b"baxus_slot", machine.key().as_ref(), &[slot_id]],
        bump
    )]
    pub slot: Account<'info, SlotAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestSpin<'info> {
    #[account(mut)]
    pub machine: Account<'info, MachineAccount>,
    #[account(
        init,
        payer = user,
        space = 8 + SpinRecord::INIT_SPACE,
        seeds = [b"baxus_spin", machine.key().as_ref(), user.key().as_ref(), machine.total_spins.to_le_bytes().as_ref()],
        bump
    )]
    pub spin_record: Account<'info, SpinRecord>,
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: Safe treasury address PDA
    #[account(
        mut,
        seeds = [b"baxus_treasury", machine.key().as_ref()],
        bump
    )]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleSpin<'info> {
    #[account(mut)]
    pub machine: Account<'info, MachineAccount>,
    #[account(mut)]
    pub spin_record: Account<'info, SpinRecord>,
    #[account(mut)]
    pub slot: Account<'info, SlotAccount>,
    pub keeper: Signer<'info>,
}

// -------------------------
// State Data Definitions
// -------------------------

#[account]
#[derive(InitSpace)]
pub struct MachineAccount {
    pub admin: Pubkey,
    pub machine_id: u64,
    pub total_spins: u64,
    pub active_slots: u8,
    pub is_active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SlotAccount {
    pub machine: Pubkey,
    pub slot_id: u8,
    pub item_sku: [u8; 16],
    pub rarity_weight: u16,
    pub remaining_stock: u16,
    pub is_configured: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SpinRecord {
    pub user: Pubkey,
    pub machine: Pubkey,
    pub user_seed: [u8; 32],
    pub request_slot: u64,
    pub settled_slot: u64,
    pub awarded_slot_id: u8,
    pub is_settled: bool,
    pub bump: u8,
}

// -------------------------
// Event Payloads
// -------------------------

#[event]
pub struct SpinRequestedEvent {
    pub user: Pubkey,
    pub machine_id: u64,
    pub request_slot: u64,
}

#[event]
pub struct DispenseTelemetryEvent {
    pub machine_id: u64,
    pub slot_id: u8,
    pub item_sku: [u8; 16],
    pub recipient: Pubkey,
    pub spin_index: u64,
    pub entropy_digest: [u8; 32],
    pub timestamp: i64,
}

// -------------------------
// Error Codes
// -------------------------

#[error_code]
pub enum VendingError {
    #[msg("Slot ID out of range [0-15].")]
    InvalidSlotId,
    #[msg("Slot rarity weight cannot be zero.")]
    ZeroWeightForbidden,
    #[msg("Physical Vending Machine is currently inactive.")]
    MachineInactive,
    #[msg("Physical Vending Machine has zero bottles in stock.")]
    MachineOutOfStock,
    #[msg("This spin commitment has already been settled.")]
    SpinAlreadySettled,
    #[msg("Settlement attempted in the same block as request. Delay required.")]
    BlockDelayNotMet,
    #[msg("Spin commitment expired. Block threshold exceeded.")]
    SpinCommitmentExpired,
    #[msg("Selected slot does not belong to this machine.")]
    MachineMismatch,
    #[msg("Target bottle slot is out of stock.")]
    SlotOutOfStock,
    #[msg("Caller is not the authorized machine administrator.")]
    UnauthorizedAdmin,
}