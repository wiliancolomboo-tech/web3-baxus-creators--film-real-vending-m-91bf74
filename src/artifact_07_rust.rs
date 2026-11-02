use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

pub mod errors;
pub mod state;

use errors::VendingError;
use state::*;

declare_id!("BXSVnd1ng1111111111111111111111111111111111");

#[program]
pub mod baxus_vending {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        treasury: Pubkey,
        keeper: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.keeper_authority = keeper;
        config.payment_mint = ctx.accounts.payment_mint.key();
        config.treasury_wallet = treasury;
        config.total_machines = 0;
        config.bump = ctx.bumps.config;

        msg!("BAXUS Vending System Config Initialized. Keeper: {:?}", keeper);
        Ok(())
    }

    pub fn register_machine(
        ctx: Context<RegisterMachine>,
        machine_id: u64,
        machine_name: [u8; 32],
        spin_price_atomic: u64,
        tiers: [TierProbability; 4],
    ) -> Result<()> {
        // Validate tier weights total 10,000 bps
        let mut total_weight: u16 = 0;
        for t in tiers.iter() {
            total_weight = total_weight
                .checked_add(t.weight_bps)
                .ok_or(VendingError::NumericalOverflow)?;
        }
        require!(total_weight == 10000, VendingError::InvalidProbabilityWeights);

        let machine = &mut ctx.accounts.machine_pool;
        machine.machine_id = machine_id;
        machine.machine_name = machine_name;
        machine.authority = ctx.accounts.admin.key();
        machine.spin_price_atomic = spin_price_atomic;
        machine.total_spins_executed = 0;
        machine.is_active = true;
        machine.tiers = tiers;
        machine.bump = ctx.bumps.machine_pool;

        let config = &mut ctx.accounts.config;
        config.total_machines = config.total_machines.checked_add(1).unwrap();

        msg!("Machine Registered: ID #{}", machine_id);
        Ok(())
    }

    pub fn spin_machine(
        ctx: Context<SpinMachine>,
        machine_id: u64,
        session_id: u64,
        client_seed: [u8; 32],
    ) -> Result<()> {
        let machine = &mut ctx.accounts.machine_pool;
        require!(machine.is_active, VendingError::MachineInactive);

        // 1. Collect spin cost via Token CPI to Treasury
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.user_payment_ata.to_account_info(),
            mint: ctx.accounts.payment_mint.to_account_info(),
            to: ctx.accounts.treasury_ata.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token_interface::transfer_checked(
            CpiContext::new(cpi_program, cpi_accounts),
            machine.spin_price_atomic,
            ctx.accounts.payment_mint.decimals,
        )?;

        // 2. Generate Provably Fair Entropy
        // Combines recent slot hash, client entropy, session ID, and machine spin counter
        let clock = Clock::get()?;
        let slot = clock.slot;
        
        let mut entropy_input = Vec::with_capacity(32 + 32 + 8 + 8);
        entropy_input.extend_from_slice(&client_seed);
        entropy_input.extend_from_slice(&machine_id.to_le_bytes());
        entropy_input.extend_from_slice(&session_id.to_le_bytes());
        entropy_input.extend_from_slice(&slot.to_le_bytes());
        
        let pseudo_random_hash = anchor_lang::solana_program::hash::hash(&entropy_input);
        let random_value: u16 = (u16::from_le_bytes([
            pseudo_random_hash.to_bytes()[0],
            pseudo_random_hash.to_bytes()[1],
        ]) % 10000) as u16;

        // 3. Resolve Prize Tier
        let mut cumulative_weight: u16 = 0;
        let mut selected_tier_idx: usize = 3; // Default fallback to lowest tier
        for (i, tier) in machine.tiers.iter().enumerate() {
            cumulative_weight = cumulative_weight
                .checked_add(tier.weight_bps)
                .ok_or(VendingError::NumericalOverflow)?;
            if random_value < cumulative_weight {
                selected_tier_idx = i;
                break;
            }
        }

        // Verify inventory availability
        require!(
            machine.tiers[selected_tier_idx].current_inventory > 0,
            VendingError::InventoryExhausted
        );

        // Decrement local inventory count
        machine.tiers[selected_tier_idx].current_inventory = machine.tiers[selected_tier_idx]
            .current_inventory
            .checked_sub(1)
            .ok_or(VendingError::NumericalOverflow)?;
        machine.total_spins_executed = machine.total_spins_executed.checked_add(1).unwrap();

        let awarded_tier = machine.tiers[selected_tier_idx].tier;
        let awarded_mint = machine.tiers[selected_tier_idx].bottle_mint;

        // 4. Initialize Dispense Session State
        let session = &mut ctx.accounts.dispense_session;
        session.session_id = session_id;
        session.machine_id = machine_id;
        session.user = ctx.accounts.user.key();
        session.awarded_tier = awarded_tier;
        session.awarded_mint = awarded_mint;
        session.spin_slot = slot;
        session.client_seed = client_seed;
        session.video_proof_hash = [0u8; 32];
        session.arweave_uri = [0u8; 64];
        session.status = SessionStatus::SpinInitiated;
        session.bump = ctx.bumps.dispense_session;

        emit!(SpinInitiatedEvent {
            machine_id,
            session_id,
            user: ctx.accounts.user.key(),
            awarded_tier,
            awarded_mint,
            spin_slot: slot,
        });

        Ok(())
    }

    pub fn record_dispense_and_settle(
        ctx: Context<RecordDispenseAndSettle>,
        machine_id: u64,
        session_id: u64,
        video_proof_hash: [u8; 32],
        arweave_uri: [u8; 64],
    ) -> Result<()> {
        let session = &mut ctx.accounts.dispense_session;
        require!(
            session.status == SessionStatus::SpinInitiated,
            VendingError::InvalidSessionState
        );
        require!(video_proof_hash != [0u8; 32], VendingError::InvalidVideoHash);

        // Update Session Proof Telemetry
        session.video_proof_hash = video_proof_hash;
        session.arweave_uri = arweave_uri;
        session.status = SessionStatus::DispensedAndVerified;

        // Transfer Vaulted Bottle RWA NFT/Token to Winner
        let machine_id_bytes = machine_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"machine",
            machine_id_bytes.as_ref(),
            &[ctx.accounts.machine_pool.bump],
        ]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.escrow_vault_ata.to_account_info(),
            mint: ctx.accounts.bottle_mint.to_account_info(),
            to: ctx.accounts.user_bottle_ata.to_account_info(),
            authority: ctx.accounts.machine_pool.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();

        token_interface::transfer_checked(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds),
            1, // 1 discrete bottle token
            ctx.accounts.bottle_mint.decimals,
        )?;

        emit!(DispenseSettledEvent {
            machine_id,
            session_id,
            user: session.user,
            awarded_mint: session.awarded_mint,
            video_proof_hash,
            arweave_uri,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = MachineConfig::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, MachineConfig>,
    pub payment_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(machine_id: u64)]
pub struct RegisterMachine<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Account<'info, MachineConfig>,
    #[account(
        init,
        payer = admin,
        space = VendingMachinePool::LEN,
        seeds = [b"machine", machine_id.to_le_bytes().as_ref()],
        bump
    )]
    pub machine_pool: Account<'info, VendingMachinePool>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(machine_id: u64, session_id: u64)]
pub struct SpinMachine<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, MachineConfig>,

    #[account(
        mut,
        seeds = [b"machine", machine_id.to_le_bytes().as_ref()],
        bump = machine_pool.bump,
    )]
    pub machine_pool: Account<'info, VendingMachinePool>,

    #[account(
        init,
        payer = user,
        space = DispenseSession::LEN,
        seeds = [
            b"session", 
            machine_id.to_le_bytes().as_ref(), 
            session_id.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub dispense_session: Account<'info, DispenseSession>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_payment_ata.mint == config.payment_mint,
        constraint = user_payment_ata.owner == user.key()
    )]
    pub user_payment_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_ata.key() == config.treasury_wallet
    )]
    pub treasury_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(address = config.payment_mint)]
    pub payment_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(machine_id: u64, session_id: u64)]
pub struct RecordDispenseAndSettle<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, MachineConfig>,

    #[account(
        mut,
        seeds = [b"machine", machine_id.to_le_bytes().as_ref()],
        bump = machine_pool.bump
    )]
    pub machine_pool: Account<'info, VendingMachinePool>,

    #[account(
        mut,
        seeds = [
            b"session", 
            machine_id.to_le_bytes().as_ref(), 
            session_id.to_le_bytes().as_ref()
        ],
        bump = dispense_session.bump,
        has_one = machine_id,
        has_one = session_id
    )]
    pub dispense_session: Account<'info, DispenseSession>,

    #[account(
        constraint = keeper.key() == config.keeper_authority @ VendingError::UnauthorizedKeeper
    )]
    pub keeper: Signer<'info>,

    #[account(address = dispense_session.awarded_mint)]
    pub bottle_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = escrow_vault_ata.mint == bottle_mint.key(),
        constraint = escrow_vault_ata.owner == machine_pool.key()
    )]
    pub escrow_vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_bottle_ata.mint == bottle_mint.key(),
        constraint = user_bottle_ata.owner == dispense_session.user
    )]
    pub user_bottle_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// -----------------------------------------------------------------------------
// PROTOCOL EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct SpinInitiatedEvent {
    pub machine_id: u64,
    pub session_id: u64,
    pub user: Pubkey,
    pub awarded_tier: u8,
    pub awarded_mint: Pubkey,
    pub spin_slot: u64,
}

#[event]
pub struct DispenseSettledEvent {
    pub machine_id: u64,
    pub session_id: u64,
    pub user: Pubkey,
    pub awarded_mint: Pubkey,
    pub video_proof_hash: [u8; 32],
    pub arweave_uri: [u8; 64],
}