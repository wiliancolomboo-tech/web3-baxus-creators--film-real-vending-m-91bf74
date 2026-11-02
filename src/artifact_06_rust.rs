use anchor_lang::prelude::*;

#[error_code]
pub enum VendingError {
    #[msg("Machine is currently inactive or under maintenance.")]
    MachineInactive,

    #[msg("Invalid authority signature for this machine.")]
    UnauthorizedKeeper,

    #[msg("Cumulative tier weights must sum up to exactly 10,000 basis points.")]
    InvalidProbabilityWeights,

    #[msg("Selected inventory tier is out of stock in this chassis.")]
    InventoryExhausted,

    #[msg("Session is not in SpinInitiated state.")]
    InvalidSessionState,

    #[msg("Provided video proof hash is zero or malformed.")]
    InvalidVideoHash,

    #[msg("Slot latency violation: Settlement occurred before commit confirmation.")]
    PrematureSettlement,

    #[msg("Math overflow encountered during reward tier calculation.")]
    NumericalOverflow,
}