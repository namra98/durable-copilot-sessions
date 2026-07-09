use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use dcs_core::paths::DcsPaths;
use dcs_core::registry::load_config;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("serve") => {
            let paths = DcsPaths::from_env();
            let config = load_config(&paths.config_file);
            let port = args
                .next()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(config.api_port);
            dcs_rs::server::serve(dcs_rs::server::ServerOptions {
                addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                paths,
            })
            .await
        }
        _ => {
            println!(
                "dcs-rs backend scaffold for {}",
                dcs_core::BACKEND_CONTRACT_KIND
            );
            Ok(())
        }
    }
}
