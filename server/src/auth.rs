use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::extract::FromRequestParts;
use axum::http::{header, request::Parts};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

use crate::db::PublicUser;
use crate::error::AppError;
use crate::state::AppState;

const AVATAR_COLORS: &[&str] = &[
    "#5865F2", "#3BA55D", "#FAA61A", "#EB459E", "#ED4245", "#00AFF4", "#9B59B6",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,
    pub username: String,
    pub role: String,
    pub exp: usize,
}

#[derive(Debug, Clone)]
pub struct AuthUser(pub PublicUser);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::Unauthorized("Yetkilendirme başlığı eksik".to_string()))?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or_else(|| AppError::Unauthorized("Geçersiz token formatı".to_string()))?
            .trim();

        let claims = verify_jwt(token, &state.config.jwt_secret)?;
        let user = state
            .db
            .find_user_by_id(&claims.sub)?
            .ok_or_else(|| AppError::Unauthorized("Kullanıcı bulunamadı".to_string()))?;

        Ok(AuthUser(user))
    }
}

pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(format!("Password hashing error: {e}")))
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool, AppError> {
    let parsed = PasswordHash::new(hash)
        .map_err(|e| AppError::Internal(format!("Invalid password hash in DB: {e}")))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

pub fn create_jwt(user: &PublicUser, secret: &str) -> Result<String, AppError> {
    let exp = (Utc::now() + Duration::days(30)).timestamp() as usize;
    let claims = Claims {
        sub: user.id.clone(),
        username: user.username.clone(),
        role: user.role.clone(),
        exp,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("JWT encode error: {e}")))
}

pub fn verify_jwt(token: &str, secret: &str) -> Result<Claims, AppError> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::Unauthorized("Oturum geçersiz veya süresi dolmuş".to_string()))
}

pub fn validate_username(username: &str) -> Result<String, AppError> {
    let trimmed = username.trim();
    if trimmed.len() < 2 || trimmed.len() > 24 {
        return Err(AppError::BadRequest(
            "Kullanıcı adı 2 ile 24 karakter arasında olmalıdır".to_string(),
        ));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err(AppError::BadRequest(
            "Kullanıcı adı sadece harf, rakam ve _ . - içerebilir".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

pub fn pick_avatar_color(username: &str) -> String {
    let sum: usize = username.bytes().map(|b| b as usize).sum();
    AVATAR_COLORS[sum % AVATAR_COLORS.len()].to_string()
}
