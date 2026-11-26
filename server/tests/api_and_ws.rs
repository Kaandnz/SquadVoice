use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use squadvoice_server::build_router;
use squadvoice_server::config::Config;
use squadvoice_server::db::Database;
use squadvoice_server::state::AppState;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use tower::ServiceExt;
use uuid::Uuid;

fn test_state(max_users: usize) -> (AppState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("squadvoice-test-{}", Uuid::new_v4()));
    let uploads = dir.join("uploads");
    std::fs::create_dir_all(&uploads).unwrap();

    let db = Database::open(&dir.join("test.db")).unwrap();
    let config = Config {
        host: "127.0.0.1".to_string(),
        port: 0,
        data_dir: dir.clone(),
        uploads_dir: uploads,
        static_dir: dir.join("nonexistent-static"),
        invite_code: "TEST-INVITE".to_string(),
        max_users,
        jwt_secret: "test-secret-at-least-32-bytes-long-12345".to_string(),
        cloudflare_turn_key_id: None,
        cloudflare_turn_api_token: None,
        turn_url: None,
        turn_username: None,
        turn_credential: None,
    };

    (AppState::new(config, db), dir)
}

async fn json_body(resp: axum::response::Response) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn auth_invite_cap_and_channels_flow() {
    let (state, dir) = test_state(2);
    let app = build_router(state);

    // Health
    let resp = app
        .clone()
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["status"], "ok");
    assert_eq!(body["max_users"], 2);

    // Wrong invite code rejected
    let resp = app
        .clone()
        .oneshot(
            Request::post("/api/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "username": "kagan",
                        "password": "secret123",
                        "invite_code": "WRONG"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // First user succeeds and becomes admin
    let resp = app
        .clone()
        .oneshot(
            Request::post("/api/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "username": "kagan",
                        "display_name": "Kagan",
                        "password": "secret123",
                        "invite_code": "TEST-INVITE"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["user"]["role"], "admin");
    let token1 = body["token"].as_str().unwrap().to_string();

    // Duplicate username rejected
    let resp = app
        .clone()
        .oneshot(
            Request::post("/api/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "username": "Kagan",
                        "password": "secret123",
                        "invite_code": "TEST-INVITE"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);

    // Second user succeeds and becomes member
    let resp = app
        .clone()
        .oneshot(
            Request::post("/api/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "username": "efe",
                        "password": "secret123",
                        "invite_code": "TEST-INVITE"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["user"]["role"], "member");

    // Third user hits MAX_USERS=2 cap
    let resp = app
        .clone()
        .oneshot(
            Request::post("/api/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "username": "mert",
                        "password": "secret123",
                        "invite_code": "TEST-INVITE"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // Login & /api/auth/me & /api/channels
    let resp = app
        .clone()
        .oneshot(
            Request::post("/api/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "username": "kagan", "password": "secret123" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = app
        .clone()
        .oneshot(
            Request::get("/api/channels")
                .header("authorization", format!("Bearer {token1}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let channels = json_body(resp).await;
    assert!(channels.as_array().unwrap().len() >= 5);

    // Create & delete channel
    let resp = app
        .clone()
        .oneshot(
            Request::post("/api/channels")
                .header("authorization", format!("Bearer {token1}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "name": "valorant", "kind": "voice" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let created = json_body(resp).await;
    let created_id = created["id"].as_str().unwrap();

    let resp = app
        .oneshot(
            Request::delete(format!("/api/channels/{created_id}"))
                .header("authorization", format!("Bearer {token1}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let _ = std::fs::remove_dir_all(dir);
}

async fn next_ws_json(
    rx: &mut (impl StreamExt<Item = Result<WsMsg, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Value {
    while let Some(Ok(msg)) = rx.next().await {
        if let WsMsg::Text(txt) = msg {
            return serde_json::from_str(txt.as_str()).unwrap();
        }
    }
    panic!("WebSocket closed before receiving expected JSON event");
}

async fn wait_for_event<F>(
    rx: &mut (impl StreamExt<Item = Result<WsMsg, tokio_tungstenite::tungstenite::Error>> + Unpin),
    predicate: F,
) -> Value
where
    F: Fn(&Value) -> bool,
{
    for _ in 0..15 {
        let ev = next_ws_json(rx).await;
        if predicate(&ev) {
            return ev;
        }
    }
    panic!("Did not receive matching WS event");
}

#[tokio::test]
async fn websocket_chat_and_voice_rtc_signaling() {
    let (state, dir) = test_state(5);
    let channels = state.db.list_channels().unwrap();
    let text_ch = channels.iter().find(|c| c.kind == "text").unwrap().id.clone();
    let voice_ch = channels
        .iter()
        .find(|c| c.kind == "voice")
        .unwrap()
        .id
        .clone();

    let app = build_router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // Register two users via HTTP client
    let client = reqwest::Client::new();
    let base = format!("http://{addr}");

    let r1: Value = client
        .post(format!("{base}/api/auth/register"))
        .json(&json!({ "username": "alice", "password": "password1", "invite_code": "TEST-INVITE" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token1 = r1["token"].as_str().unwrap();
    let user1_id = r1["user"]["id"].as_str().unwrap().to_string();

    let r2: Value = client
        .post(format!("{base}/api/auth/register"))
        .json(&json!({ "username": "bob", "password": "password2", "invite_code": "TEST-INVITE" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token2 = r2["token"].as_str().unwrap();
    let user2_id = r2["user"]["id"].as_str().unwrap().to_string();

    // Connect both WebSockets
    let (ws1, _) = connect_async(format!("ws://{addr}/ws?token={token1}"))
        .await
        .unwrap();
    let (mut tx1, mut rx1) = ws1.split();
    let ready1 = next_ws_json(&mut rx1).await;
    assert_eq!(ready1["type"], "ready");

    let (ws2, _) = connect_async(format!("ws://{addr}/ws?token={token2}"))
        .await
        .unwrap();
    let (mut tx2, mut rx2) = ws2.split();
    let ready2 = next_ws_json(&mut rx2).await;
    assert_eq!(ready2["type"], "ready");

    // Text message over WS persists and broadcasts
    tx1.send(WsMsg::Text(
        json!({
            "type": "send_message",
            "channel_id": text_ch,
            "content": "Selam ekip!",
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let msg_ev = wait_for_event(&mut rx2, |v| v["type"] == "message_created").await;
    assert_eq!(msg_ev["message"]["content"], "Selam ekip!");

    // Verify persisted in REST history
    let history: Vec<Value> = client
        .get(format!("{base}/api/channels/{text_ch}/messages"))
        .bearer_auth(token2)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["content"], "Selam ekip!");

    // RTC offer before both users are in the same voice channel must NOT be forwarded
    tx1.send(WsMsg::Text(
        json!({
            "type": "rtc_offer",
            "target_user_id": user2_id,
            "sdp": { "type": "offer", "sdp": "v=0" }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    // Both join voice channel
    tx1.send(WsMsg::Text(
        json!({ "type": "join_voice", "channel_id": voice_ch })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    tx2.send(WsMsg::Text(
        json!({ "type": "join_voice", "channel_id": voice_ch })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();

    wait_for_event(&mut rx1, |v| {
        v["type"] == "voice_members_update" && v["voice_members"].as_array().unwrap().len() == 2
    })
    .await;
    wait_for_event(&mut rx2, |v| {
        v["type"] == "voice_members_update" && v["voice_members"].as_array().unwrap().len() == 2
    })
    .await;

    // Now RTC offer between peers in the same voice channel MUST be forwarded
    tx1.send(WsMsg::Text(
        json!({
            "type": "rtc_offer",
            "target_user_id": user2_id,
            "sdp": { "type": "offer", "sdp": "v=0-valid" },
            "screen_stream_id": "screen-1"
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    let offer_ev = wait_for_event(&mut rx2, |v| v["type"] == "rtc_offer").await;
    assert_eq!(offer_ev["from_user_id"], user1_id);
    assert_eq!(offer_ev["sdp"]["sdp"], "v=0-valid");
    assert_eq!(offer_ev["screen_stream_id"], "screen-1");

    let _ = std::fs::remove_dir_all(dir);
}
