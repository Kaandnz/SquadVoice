use std::fs;
use std::path::PathBuf;
use rand_core::{OsRng, RngCore};

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub uploads_dir: PathBuf,
    pub static_dir: PathBuf,
    pub invite_code: String,
    pub max_users: usize,
    pub jwt_secret: String,
    pub cloudflare_turn_key_id: Option<String>,
    pub cloudflare_turn_api_token: Option<String>,
    pub turn_url: Option<String>,
    pub turn_username: Option<String>,
    pub turn_credential: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        dotenvy::dotenv().ok();

        let host = env_or("HOST", "0.0.0.0");
        let port = env_or("PORT", "3001").parse::<u16>().unwrap_or(3001);
        let data_dir = PathBuf::from(env_or("DATA_DIR", "./data"));
        let uploads_dir = data_dir.join("uploads");
        let static_dir = PathBuf::from(env_or("STATIC_DIR", "../client/dist"));
        let invite_code = env_or("INVITE_CODE", "SQUAD-2026");
        let max_users = env_or("MAX_USERS", "5").parse::<usize>().unwrap_or(5).max(1);

        fs::create_dir_all(&data_dir)?;
        fs::create_dir_all(&uploads_dir)?;

        let jwt_secret = match non_empty_env("JWT_SECRET") {
            Some(secret) => secret,
            None => load_or_create_jwt_secret(&data_dir)?,
        };

        Ok(Self {
            host,
            port,
            data_dir,
            uploads_dir,
            static_dir,
            invite_code,
            max_users,
            jwt_secret,
            cloudflare_turn_key_id: non_empty_env("CLOUDFLARE_TURN_KEY_ID"),
            cloudflare_turn_api_token: non_empty_env("CLOUDFLARE_TURN_API_TOKEN"),
            turn_url: non_empty_env("TURN_URL"),
            turn_username: non_empty_env("TURN_USERNAME"),
            turn_credential: non_empty_env("TURN_CREDENTIAL"),
        })
    }

    pub fn has_turn(&self) -> bool {
        (self.cloudflare_turn_key_id.is_some() && self.cloudflare_turn_api_token.is_some())
            || self.turn_url.is_some()
    }
}

fn env_or(key: &str, default: &str) -> String {
    non_empty_env(key).unwrap_or_else(|| default.to_string())
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn load_or_create_jwt_secret(data_dir: &PathBuf) -> Result<String, std::io::Error> {
    let key_path = data_dir.join("jwt_secret.key");
    if let Ok(existing) = fs::read_to_string(&key_path) {
        let trimmed = existing.trim();
        if trimmed.len() >= 32 {
            return Ok(trimmed.to_string());
        }
    }

    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let hex_secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    fs::write(&key_path, &hex_secret)?;
    Ok(hex_secret)
}
