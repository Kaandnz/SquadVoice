use std::net::SocketAddr;

use squadvoice_server::build_router;
use squadvoice_server::config::Config;
use squadvoice_server::db::Database;
use squadvoice_server::state::AppState;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    let db_path = config.data_dir.join("squadvoice.db");
    let db = Database::open(&db_path)?;

    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;

    println!("================================================");
    println!("  SquadVoice Rust Server v{}", env!("CARGO_PKG_VERSION"));
    println!("  Listening   : http://{}", addr);
    println!("  Data Dir    : {}", config.data_dir.display());
    println!("  Invite Code : {}", config.invite_code);
    println!("  Max Users   : {}", config.max_users);
    println!(
        "  TURN Relay  : {}",
        if config.has_turn() {
            "Aktif"
        } else {
            "Sadece STUN (opsiyonel TURN ayarlı değil)"
        }
    );
    println!("================================================");

    let state = AppState::new(config, db);
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
