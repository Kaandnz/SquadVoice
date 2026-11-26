use axum::extract::{Multipart, Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{
    create_jwt, hash_password, pick_avatar_color, validate_username, verify_password, AuthUser,
};
use crate::db::{ChannelDto, MessageDto, PublicUser};
use crate::error::AppError;
use crate::state::AppState;
use crate::ws::WsServerEvent;

const MAX_UPLOAD_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub max_users: usize,
    pub turn_configured: bool,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub display_name: Option<String>,
    pub password: String,
    pub invite_code: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: PublicUser,
}

#[derive(Serialize)]
pub struct UserWrapper {
    pub user: PublicUser,
}

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    pub kind: String,
}

#[derive(Deserialize)]
pub struct MessagesQuery {
    pub limit: Option<usize>,
    pub before: Option<String>,
}

#[derive(Serialize)]
pub struct UploadResponse {
    pub url: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtcConfigResponse {
    pub ice_servers: Vec<IceServer>,
    pub turn_enabled: bool,
}

pub async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        max_users: state.config.max_users,
        turn_configured: state.config.has_turn(),
    })
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    if req.invite_code.trim() != state.config.invite_code {
        return Err(AppError::Forbidden("Geçersiz davet kodu".to_string()));
    }

    let username = validate_username(&req.username)?;
    if req.password.len() < 6 {
        return Err(AppError::BadRequest(
            "Şifre en az 6 karakter olmalıdır".to_string(),
        ));
    }

    let current_users = state.db.count_users()?;
    if current_users >= state.config.max_users {
        return Err(AppError::Forbidden(format!(
            "Sunucu maksimum kullanıcı sayısına ulaştı ({})",
            state.config.max_users
        )));
    }

    let display_name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&username)
        .chars()
        .take(32)
        .collect::<String>();

    let role = if current_users == 0 { "admin" } else { "member" };
    let password_hash = hash_password(&req.password)?;
    let avatar_color = pick_avatar_color(&username);

    let user = state
        .db
        .create_user(&username, &display_name, &avatar_color, &password_hash, role)?;
    let token = create_jwt(&user, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse { token, user }))
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let username = req.username.trim();
    let record = state
        .db
        .find_user_by_username(username)?
        .ok_or_else(|| AppError::Unauthorized("Kullanıcı adı veya şifre hatalı".to_string()))?;

    if !verify_password(&req.password, &record.password_hash)? {
        return Err(AppError::Unauthorized(
            "Kullanıcı adı veya şifre hatalı".to_string(),
        ));
    }

    let token = create_jwt(&record.public, &state.config.jwt_secret)?;
    Ok(Json(AuthResponse {
        token,
        user: record.public,
    }))
}

pub async fn me(AuthUser(user): AuthUser) -> Json<UserWrapper> {
    Json(UserWrapper { user })
}

pub async fn list_users(
    AuthUser(_user): AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<PublicUser>>, AppError> {
    Ok(Json(state.db.list_users()?))
}

pub async fn list_channels(
    AuthUser(_user): AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ChannelDto>>, AppError> {
    Ok(Json(state.db.list_channels()?))
}

pub async fn create_channel(
    AuthUser(_user): AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateChannelRequest>,
) -> Result<Json<ChannelDto>, AppError> {
    let name = req.name.trim();
    if name.is_empty() || name.len() > 32 {
        return Err(AppError::BadRequest(
            "Kanal adı 1 ile 32 karakter arasında olmalıdır".to_string(),
        ));
    }
    if req.kind != "text" && req.kind != "voice" {
        return Err(AppError::BadRequest(
            "Kanal türü 'text' veya 'voice' olmalıdır".to_string(),
        ));
    }

    let channel = state.db.create_channel(name, &req.kind)?;
    state
        .broadcast(&WsServerEvent::ChannelCreated {
            channel: channel.clone(),
        })
        .await;
    Ok(Json(channel))
}

pub async fn delete_channel(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    if user.role != "admin" {
        return Err(AppError::Forbidden(
            "Kanal silme yetkisi sadece yöneticidedir".to_string(),
        ));
    }

    let deleted = state.db.delete_channel(&channel_id)?;
    if !deleted {
        return Err(AppError::NotFound("Kanal bulunamadı".to_string()));
    }

    let voice_changed = {
        let mut hub = state.hub.write().await;
        let before = hub.voice_members.len();
        hub.voice_members.retain(|_, m| m.channel_id != channel_id);
        hub.voice_members.len() != before
    };

    state
        .broadcast(&WsServerEvent::ChannelDeleted { channel_id })
        .await;
    if voice_changed {
        let (_, voice_members) = state.snapshot_presence().await;
        state
            .broadcast(&WsServerEvent::VoiceMembersUpdate { voice_members })
            .await;
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn list_messages(
    AuthUser(_user): AuthUser,
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<Vec<MessageDto>>, AppError> {
    let _channel = state
        .db
        .get_channel(&channel_id)?
        .ok_or_else(|| AppError::NotFound("Kanal bulunamadı".to_string()))?;

    let limit = query.limit.unwrap_or(50);
    let msgs = state
        .db
        .list_messages(&channel_id, limit, query.before.as_deref())?;
    Ok(Json(msgs))
}

pub async fn upload_file(
    AuthUser(_user): AuthUser,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<UploadResponse>, AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("Dosya okunamadı: {e}")))?
    {
        let original_name = field
            .file_name()
            .map(ToString::to_string)
            .unwrap_or_else(|| "image.png".to_string());

        let ext = original_name
            .rsplit('.')
            .next()
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        let allowed = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif");
        if !allowed {
            return Err(AppError::BadRequest(
                "Sadece png, jpg, jpeg, webp ve gif dosyaları yüklenebilir".to_string(),
            ));
        }

        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("Dosya verisi alınamadı: {e}")))?;

        if data.is_empty() {
            return Err(AppError::BadRequest("Boş dosya yüklenemez".to_string()));
        }
        if data.len() > MAX_UPLOAD_BYTES {
            return Err(AppError::PayloadTooLarge(
                "Dosya boyutu en fazla 8 MB olabilir".to_string(),
            ));
        }

        let stored_name = format!("{}.{}", Uuid::new_v4(), ext);
        let dest = state.config.uploads_dir.join(&stored_name);
        tokio::fs::write(&dest, &data).await?;

        return Ok(Json(UploadResponse {
            url: format!("/uploads/{stored_name}"),
            name: original_name,
        }));
    }

    Err(AppError::BadRequest("Yüklenecek dosya bulunamadı".to_string()))
}

#[derive(Deserialize)]
struct CloudflareIceResponse {
    #[serde(rename = "iceServers")]
    ice_servers: Option<IceServersField>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum IceServersField {
    Single(IceServer),
    List(Vec<IceServer>),
}

pub async fn rtc_config(
    AuthUser(_user): AuthUser,
    State(state): State<AppState>,
) -> Json<RtcConfigResponse> {
    let mut ice_servers = vec![IceServer {
        urls: vec![
            "stun:stun.l.google.com:19302".to_string(),
            "stun:stun.cloudflare.com:3478".to_string(),
        ],
        username: None,
        credential: None,
    }];

    let mut turn_enabled = false;

    if let (Some(key_id), Some(api_token)) = (
        &state.config.cloudflare_turn_key_id,
        &state.config.cloudflare_turn_api_token,
    ) {
        let url = format!(
            "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
        );
        if let Ok(resp) = state
            .http
            .post(&url)
            .bearer_auth(api_token)
            .json(&serde_json::json!({ "ttl": 86400 }))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(parsed) = resp.json::<CloudflareIceResponse>().await {
                    if let Some(servers) = parsed.ice_servers {
                        match servers {
                            IceServersField::Single(s) => {
                                ice_servers.push(s);
                                turn_enabled = true;
                            }
                            IceServersField::List(list) => {
                                if !list.is_empty() {
                                    ice_servers.extend(list);
                                    turn_enabled = true;
                                }
                            }
                        }
                    }
                }
            } else {
                tracing::warn!("Cloudflare TURN API returned status {}", resp.status());
            }
        }
    } else if let Some(turn_url) = &state.config.turn_url {
        ice_servers.push(IceServer {
            urls: vec![turn_url.clone()],
            username: state.config.turn_username.clone(),
            credential: state.config.turn_credential.clone(),
        });
        turn_enabled = true;
    }

    Json(RtcConfigResponse {
        ice_servers,
        turn_enabled,
    })
}
