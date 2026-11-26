use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, RwLock};

use crate::config::Config;
use crate::db::{Database, PublicUser};
use crate::ws::WsServerEvent;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VoiceMemberState {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub channel_id: String,
    pub muted: bool,
    pub deafened: bool,
    pub screen_sharing: bool,
    pub screen_stream_id: Option<String>,
    pub speaking: bool,
}

#[derive(Clone)]
pub struct ConnectionEntry {
    pub connection_id: String,
    pub tx: mpsc::UnboundedSender<WsServerEvent>,
}

#[derive(Default)]
pub struct HubState {
    pub connections: HashMap<String, ConnectionEntry>,
    pub online_users: HashMap<String, PublicUser>,
    pub voice_members: HashMap<String, VoiceMemberState>,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Database,
    pub http: reqwest::Client,
    pub hub: Arc<RwLock<HubState>>,
}

impl AppState {
    pub fn new(config: Config, db: Database) -> Self {
        Self {
            config: Arc::new(config),
            db,
            http: reqwest::Client::new(),
            hub: Arc::new(RwLock::new(HubState::default())),
        }
    }

    pub async fn broadcast(&self, event: &WsServerEvent) {
        let hub = self.hub.read().await;
        for entry in hub.connections.values() {
            let _ = entry.tx.send(event.clone());
        }
    }

    pub async fn send_to_user(&self, user_id: &str, event: WsServerEvent) {
        let hub = self.hub.read().await;
        if let Some(entry) = hub.connections.get(user_id) {
            let _ = entry.tx.send(event);
        }
    }

    pub async fn snapshot_presence(&self) -> (Vec<PublicUser>, Vec<VoiceMemberState>) {
        let hub = self.hub.read().await;
        let mut online: Vec<PublicUser> = hub.online_users.values().cloned().collect();
        online.sort_by(|a, b| a.username.cmp(&b.username));
        let mut voice: Vec<VoiceMemberState> = hub.voice_members.values().cloned().collect();
        voice.sort_by(|a, b| a.username.cmp(&b.username));
        (online, voice)
    }

    pub async fn cleanup_connection(&self, user_id: &str, connection_id: &str) {
        let (removed_online, removed_voice) = {
            let mut hub = self.hub.write().await;
            let is_current = hub
                .connections
                .get(user_id)
                .map(|c| c.connection_id == connection_id)
                .unwrap_or(false);

            if !is_current {
                return;
            }

            hub.connections.remove(user_id);
            let removed_online = hub.online_users.remove(user_id).is_some();
            let removed_voice = hub.voice_members.remove(user_id).is_some();
            (removed_online, removed_voice)
        };

        let (online_users, voice_members) = self.snapshot_presence().await;
        if removed_online {
            self.broadcast(&WsServerEvent::PresenceUpdate { online_users })
                .await;
        }
        if removed_voice {
            self.broadcast(&WsServerEvent::VoiceMembersUpdate { voice_members })
                .await;
        }
    }
}
