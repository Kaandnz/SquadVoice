use std::path::Path;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublicUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub role: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct UserRecord {
    pub public: PublicUser,
    pub password_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChannelDto {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub position: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MessageDto {
    pub id: String,
    pub channel_id: String,
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub content: String,
    pub attachment_url: Option<String>,
    pub attachment_name: Option<String>,
    pub created_at: String,
}

impl Database {
    pub fn open(db_path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                avatar_color TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('text', 'voice')),
                position INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                attachment_url TEXT,
                attachment_name TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_channel_created
                ON messages(channel_id, created_at DESC);
            ",
        )?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.seed_default_channels()?;
        Ok(db)
    }

    fn seed_default_channels(&self) -> Result<(), AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM channels", [], |row| row.get(0))?;
        if count > 0 {
            return Ok(());
        }

        let now = Utc::now().to_rfc3339();
        let defaults = [
            ("genel", "text", 0_i64),
            ("medya-link", "text", 1_i64),
            ("Oyun Odası", "voice", 2_i64),
            ("Sohbet & Yayın", "voice", 3_i64),
            ("AFK", "voice", 4_i64),
        ];

        for (name, kind, pos) in defaults {
            conn.execute(
                "INSERT INTO channels (id, name, kind, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![Uuid::new_v4().to_string(), name, kind, pos, now],
            )?;
        }
        Ok(())
    }

    pub fn count_users(&self) -> Result<usize, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    pub fn create_user(
        &self,
        username: &str,
        display_name: &str,
        avatar_color: &str,
        password_hash: &str,
        role: &str,
    ) -> Result<PublicUser, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;

        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM users WHERE username = ?1",
                params![username],
                |row| row.get(0),
            )
            .optional()?;

        if existing.is_some() {
            return Err(AppError::Conflict("Bu kullanıcı adı zaten alınmış".to_string()));
        }

        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO users (id, username, display_name, avatar_color, password_hash, role, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, username, display_name, avatar_color, password_hash, role, created_at],
        )?;

        Ok(PublicUser {
            id,
            username: username.to_string(),
            display_name: display_name.to_string(),
            avatar_color: avatar_color.to_string(),
            role: role.to_string(),
            created_at,
        })
    }

    pub fn find_user_by_username(&self, username: &str) -> Result<Option<UserRecord>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let user = conn
            .query_row(
                "SELECT id, username, display_name, avatar_color, password_hash, role, created_at
                 FROM users WHERE username = ?1",
                params![username],
                |row| {
                    Ok(UserRecord {
                        public: PublicUser {
                            id: row.get(0)?,
                            username: row.get(1)?,
                            display_name: row.get(2)?,
                            avatar_color: row.get(3)?,
                            role: row.get(5)?,
                            created_at: row.get(6)?,
                        },
                        password_hash: row.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(user)
    }

    pub fn find_user_by_id(&self, user_id: &str) -> Result<Option<PublicUser>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let user = conn
            .query_row(
                "SELECT id, username, display_name, avatar_color, role, created_at
                 FROM users WHERE id = ?1",
                params![user_id],
                |row| {
                    Ok(PublicUser {
                        id: row.get(0)?,
                        username: row.get(1)?,
                        display_name: row.get(2)?,
                        avatar_color: row.get(3)?,
                        role: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(user)
    }

    pub fn list_users(&self) -> Result<Vec<PublicUser>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, username, display_name, avatar_color, role, created_at
             FROM users ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PublicUser {
                id: row.get(0)?,
                username: row.get(1)?,
                display_name: row.get(2)?,
                avatar_color: row.get(3)?,
                role: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        let mut users = Vec::new();
        for row in rows {
            users.push(row?);
        }
        Ok(users)
    }

    pub fn list_channels(&self) -> Result<Vec<ChannelDto>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, position, created_at FROM channels ORDER BY position ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ChannelDto {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                position: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        let mut channels = Vec::new();
        for row in rows {
            channels.push(row?);
        }
        Ok(channels)
    }

    pub fn get_channel(&self, channel_id: &str) -> Result<Option<ChannelDto>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let channel = conn
            .query_row(
                "SELECT id, name, kind, position, created_at FROM channels WHERE id = ?1",
                params![channel_id],
                |row| {
                    Ok(ChannelDto {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        kind: row.get(2)?,
                        position: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(channel)
    }

    pub fn create_channel(&self, name: &str, kind: &str) -> Result<ChannelDto, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let max_pos: i64 = conn
            .query_row("SELECT COALESCE(MAX(position), -1) FROM channels", [], |r| r.get(0))
            .unwrap_or(-1);
        let id = Uuid::new_v4().to_string();
        let position = max_pos + 1;
        let created_at = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO channels (id, name, kind, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, kind, position, created_at],
        )?;

        Ok(ChannelDto {
            id,
            name: name.to_string(),
            kind: kind.to_string(),
            position,
            created_at,
        })
    }

    pub fn delete_channel(&self, channel_id: &str) -> Result<bool, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let affected = conn.execute("DELETE FROM channels WHERE id = ?1", params![channel_id])?;
        Ok(affected > 0)
    }

    pub fn create_message(
        &self,
        channel_id: &str,
        user_id: &str,
        content: &str,
        attachment_url: Option<&str>,
        attachment_name: Option<&str>,
    ) -> Result<MessageDto, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO messages (id, channel_id, user_id, content, attachment_url, attachment_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, channel_id, user_id, content, attachment_url, attachment_name, created_at],
        )?;

        let (username, display_name, avatar_color): (String, String, String) = conn.query_row(
            "SELECT username, display_name, avatar_color FROM users WHERE id = ?1",
            params![user_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;

        Ok(MessageDto {
            id,
            channel_id: channel_id.to_string(),
            user_id: user_id.to_string(),
            username,
            display_name,
            avatar_color,
            content: content.to_string(),
            attachment_url: attachment_url.map(ToString::to_string),
            attachment_name: attachment_name.map(ToString::to_string),
            created_at,
        })
    }

    pub fn list_messages(
        &self,
        channel_id: &str,
        limit: usize,
        before: Option<&str>,
    ) -> Result<Vec<MessageDto>, AppError> {
        let conn = self.conn.lock().map_err(|e| AppError::Internal(e.to_string()))?;
        let capped = limit.clamp(1, 100) as i64;

        let mut msgs = Vec::new();
        if let Some(before_ts) = before {
            let mut stmt = conn.prepare(
                "SELECT m.id, m.channel_id, m.user_id, u.username, u.display_name, u.avatar_color,
                        m.content, m.attachment_url, m.attachment_name, m.created_at
                 FROM messages m
                 JOIN users u ON u.id = m.user_id
                 WHERE m.channel_id = ?1 AND m.created_at < ?2
                 ORDER BY m.created_at DESC
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![channel_id, before_ts, capped], map_message_row)?;
            for row in rows {
                msgs.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT m.id, m.channel_id, m.user_id, u.username, u.display_name, u.avatar_color,
                        m.content, m.attachment_url, m.attachment_name, m.created_at
                 FROM messages m
                 JOIN users u ON u.id = m.user_id
                 WHERE m.channel_id = ?1
                 ORDER BY m.created_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![channel_id, capped], map_message_row)?;
            for row in rows {
                msgs.push(row?);
            }
        }

        msgs.reverse();
        Ok(msgs)
    }
}

fn map_message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageDto> {
    Ok(MessageDto {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        user_id: row.get(2)?,
        username: row.get(3)?,
        display_name: row.get(4)?,
        avatar_color: row.get(5)?,
        content: row.get(6)?,
        attachment_url: row.get(7)?,
        attachment_name: row.get(8)?,
        created_at: row.get(9)?,
    })
}
