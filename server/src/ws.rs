use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::verify_jwt;
use crate::db::{ChannelDto, MessageDto, PublicUser};
use crate::error::AppError;
use crate::state::{AppState, ConnectionEntry, VoiceMemberState};

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsClientEvent {
    Ping {
        ts: i64,
    },
    SendMessage {
        channel_id: String,
        content: String,
        attachment_url: Option<String>,
        attachment_name: Option<String>,
    },
    JoinVoice {
        channel_id: String,
    },
    LeaveVoice,
    VoiceStateUpdate {
        muted: bool,
        deafened: bool,
        screen_sharing: bool,
        screen_stream_id: Option<String>,
    },
    Speaking {
        speaking: bool,
    },
    RtcOffer {
        target_user_id: String,
        sdp: serde_json::Value,
        screen_stream_id: Option<String>,
    },
    RtcAnswer {
        target_user_id: String,
        sdp: serde_json::Value,
    },
    RtcIceCandidate {
        target_user_id: String,
        candidate: serde_json::Value,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsServerEvent {
    Pong {
        ts: i64,
    },
    Ready {
        self_user: PublicUser,
        online_users: Vec<PublicUser>,
        voice_members: Vec<VoiceMemberState>,
    },
    PresenceUpdate {
        online_users: Vec<PublicUser>,
    },
    VoiceMembersUpdate {
        voice_members: Vec<VoiceMemberState>,
    },
    UserSpeaking {
        user_id: String,
        speaking: bool,
    },
    MessageCreated {
        message: MessageDto,
    },
    ChannelCreated {
        channel: ChannelDto,
    },
    ChannelDeleted {
        channel_id: String,
    },
    RtcOffer {
        from_user_id: String,
        sdp: serde_json::Value,
        screen_stream_id: Option<String>,
    },
    RtcAnswer {
        from_user_id: String,
        sdp: serde_json::Value,
    },
    RtcIceCandidate {
        from_user_id: String,
        candidate: serde_json::Value,
    },
    Error {
        message: String,
    },
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let claims = verify_jwt(&query.token, &state.config.jwt_secret)?;
    let user = state
        .db
        .find_user_by_id(&claims.sub)?
        .ok_or_else(|| AppError::Unauthorized("Kullanıcı bulunamadı".to_string()))?;

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state, user)))
}

async fn handle_socket(socket: WebSocket, state: AppState, user: PublicUser) {
    let connection_id = Uuid::new_v4().to_string();
    let user_id = user.id.clone();

    let (tx, mut rx) = mpsc::unbounded_channel::<WsServerEvent>();

    {
        let mut hub = state.hub.write().await;
        hub.connections.insert(
            user_id.clone(),
            ConnectionEntry {
                connection_id: connection_id.clone(),
                tx: tx.clone(),
            },
        );
        hub.online_users.insert(user_id.clone(), user.clone());
    }

    let (online_users, voice_members) = state.snapshot_presence().await;
    let _ = tx.send(WsServerEvent::Ready {
        self_user: user.clone(),
        online_users: online_users.clone(),
        voice_members,
    });
    state
        .broadcast(&WsServerEvent::PresenceUpdate { online_users })
        .await;

    let (mut sender, mut receiver) = socket.split();

    let writer_task = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match serde_json::to_string(&event) {
                Ok(text) => {
                    if sender.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    tracing::error!("WS serialize error: {err}");
                }
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<WsClientEvent>(text.as_str()) {
                Ok(event) => handle_client_event(&state, &user, &tx, event).await,
                Err(err) => {
                    let _ = tx.send(WsServerEvent::Error {
                        message: format!("Geçersiz mesaj biçimi: {err}"),
                    });
                }
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    writer_task.abort();
    state.cleanup_connection(&user_id, &connection_id).await;
}

async fn handle_client_event(
    state: &AppState,
    user: &PublicUser,
    tx: &mpsc::UnboundedSender<WsServerEvent>,
    event: WsClientEvent,
) {
    match event {
        WsClientEvent::Ping { ts } => {
            let _ = tx.send(WsServerEvent::Pong { ts });
        }
        WsClientEvent::SendMessage {
            channel_id,
            content,
            attachment_url,
            attachment_name,
        } => {
            let trimmed = content.trim();
            if trimmed.is_empty() && attachment_url.is_none() {
                return;
            }
            if trimmed.len() > 4000 {
                let _ = tx.send(WsServerEvent::Error {
                    message: "Mesaj 4000 karakterden uzun olamaz".to_string(),
                });
                return;
            }
            match state.db.get_channel(&channel_id) {
                Ok(Some(ch)) if ch.kind == "text" => {
                    match state.db.create_message(
                        &channel_id,
                        &user.id,
                        trimmed,
                        attachment_url.as_deref(),
                        attachment_name.as_deref(),
                    ) {
                        Ok(message) => {
                            state
                                .broadcast(&WsServerEvent::MessageCreated { message })
                                .await;
                        }
                        Err(err) => {
                            tracing::error!("Message persist error: {err:?}");
                            let _ = tx.send(WsServerEvent::Error {
                                message: "Mesaj kaydedilemedi".to_string(),
                            });
                        }
                    }
                }
                _ => {
                    let _ = tx.send(WsServerEvent::Error {
                        message: "Metin kanalı bulunamadı".to_string(),
                    });
                }
            }
        }
        WsClientEvent::JoinVoice { channel_id } => {
            match state.db.get_channel(&channel_id) {
                Ok(Some(ch)) if ch.kind == "voice" => {
                    {
                        let mut hub = state.hub.write().await;
                        let existing = hub.voice_members.get(&user.id).cloned();
                        hub.voice_members.insert(
                            user.id.clone(),
                            VoiceMemberState {
                                user_id: user.id.clone(),
                                username: user.username.clone(),
                                display_name: user.display_name.clone(),
                                avatar_color: user.avatar_color.clone(),
                                channel_id,
                                muted: existing.as_ref().map(|v| v.muted).unwrap_or(false),
                                deafened: existing.as_ref().map(|v| v.deafened).unwrap_or(false),
                                screen_sharing: false,
                                screen_stream_id: None,
                                speaking: false,
                            },
                        );
                    }
                    let (_, voice_members) = state.snapshot_presence().await;
                    state
                        .broadcast(&WsServerEvent::VoiceMembersUpdate { voice_members })
                        .await;
                }
                _ => {
                    let _ = tx.send(WsServerEvent::Error {
                        message: "Ses kanalı bulunamadı".to_string(),
                    });
                }
            }
        }
        WsClientEvent::LeaveVoice => {
            let removed = {
                let mut hub = state.hub.write().await;
                hub.voice_members.remove(&user.id).is_some()
            };
            if removed {
                let (_, voice_members) = state.snapshot_presence().await;
                state
                    .broadcast(&WsServerEvent::VoiceMembersUpdate { voice_members })
                    .await;
            }
        }
        WsClientEvent::VoiceStateUpdate {
            muted,
            deafened,
            screen_sharing,
            screen_stream_id,
        } => {
            let updated = {
                let mut hub = state.hub.write().await;
                if let Some(member) = hub.voice_members.get_mut(&user.id) {
                    member.muted = muted;
                    member.deafened = deafened;
                    member.screen_sharing = screen_sharing;
                    member.screen_stream_id = if screen_sharing {
                        screen_stream_id
                    } else {
                        None
                    };
                    if muted || deafened {
                        member.speaking = false;
                    }
                    true
                } else {
                    false
                }
            };
            if updated {
                let (_, voice_members) = state.snapshot_presence().await;
                state
                    .broadcast(&WsServerEvent::VoiceMembersUpdate { voice_members })
                    .await;
            }
        }
        WsClientEvent::Speaking { speaking } => {
            let should_broadcast = {
                let mut hub = state.hub.write().await;
                if let Some(member) = hub.voice_members.get_mut(&user.id) {
                    let effective = speaking && !member.muted && !member.deafened;
                    if member.speaking != effective {
                        member.speaking = effective;
                        Some(effective)
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            if let Some(effective) = should_broadcast {
                state
                    .broadcast(&WsServerEvent::UserSpeaking {
                        user_id: user.id.clone(),
                        speaking: effective,
                    })
                    .await;
            }
        }
        WsClientEvent::RtcOffer {
            target_user_id,
            sdp,
            screen_stream_id,
        } => {
            if same_voice_channel(state, &user.id, &target_user_id).await {
                state
                    .send_to_user(
                        &target_user_id,
                        WsServerEvent::RtcOffer {
                            from_user_id: user.id.clone(),
                            sdp,
                            screen_stream_id,
                        },
                    )
                    .await;
            }
        }
        WsClientEvent::RtcAnswer {
            target_user_id,
            sdp,
        } => {
            if same_voice_channel(state, &user.id, &target_user_id).await {
                state
                    .send_to_user(
                        &target_user_id,
                        WsServerEvent::RtcAnswer {
                            from_user_id: user.id.clone(),
                            sdp,
                        },
                    )
                    .await;
            }
        }
        WsClientEvent::RtcIceCandidate {
            target_user_id,
            candidate,
        } => {
            if same_voice_channel(state, &user.id, &target_user_id).await {
                state
                    .send_to_user(
                        &target_user_id,
                        WsServerEvent::RtcIceCandidate {
                            from_user_id: user.id.clone(),
                            candidate,
                        },
                    )
                    .await;
            }
        }
    }
}

async fn same_voice_channel(state: &AppState, user_a: &str, user_b: &str) -> bool {
    if user_a == user_b {
        return false;
    }
    let hub = state.hub.read().await;
    match (hub.voice_members.get(user_a), hub.voice_members.get(user_b)) {
        (Some(a), Some(b)) => a.channel_id == b.channel_id,
        _ => false,
    }
}
