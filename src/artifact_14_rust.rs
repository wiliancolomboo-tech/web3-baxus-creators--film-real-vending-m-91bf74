use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
};
use std::{str::FromStr, sync::Arc, thread, time::Duration};

const PROGRAM_ID_STR: &str = "BXSVnd1111111111111111111111111111111111111";
const MACHINE_ID: u32 = 101;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Starting BAXUS Hardware IoT Controller Node...");
    let rpc_url = std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8899".to_string());
    let hardware_keypair_path = std::env::var("KEYPAIR_PATH").unwrap_or_else(|_| "/etc/baxus/iot_key.json".to_string());

    let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());
    let hardware_keypair = read_keypair_file(&hardware_keypair_path)
        .expect("Failed to load IoT hardware keypair");
    let program_id = Pubkey::from_str(PROGRAM_ID_STR)?;

    println!("Hardware Oracle Public Key: {}", hardware_keypair.pubkey());
    println!("Listening for DispenseReceipt events on Machine ID: {}", MACHINE_ID);

    loop {
        // Poll and listen for confirmed DispenseReceipt events targeted to this machine_id
        // Upon event receipt:
        // 1. Actuate GPIO Pin for Camera Light & Multi-Cam Recording
        // 2. Drive Stepper Motor to specified rack slot
        // 3. Monitor IR drop beam
        // 4. Submit `confirm_dispense` transaction on-chain
        thread::sleep(Duration::from_millis(500));
    }
}