pub mod api;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod state;
pub mod ws;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, Method};
use axum::routing::{delete, get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    let api_router = Router::new()
        .route("/health", get(api::health))
        .route("/auth/register", post(api::register))
        .route("/auth/login", post(api::login))
        .route("/auth/me", get(api::me))
        .route("/users", get(api::list_users))
        .route("/channels", get(api::list_channels).post(api::create_channel))
        .route("/channels/{id}", delete(api::delete_channel))
        .route("/channels/{id}/messages", get(api::list_messages))
        .route(
            "/uploads",
            post(api::upload_file).layer(DefaultBodyLimit::max(9 * 1024 * 1024)),
        )
        .route("/rtc-config", get(api::rtc_config));

    let uploads_service = ServeDir::new(&state.config.uploads_dir);

    let mut router = Router::new()
        .nest("/api", api_router)
        .route("/ws", get(ws::ws_handler))
        .nest_service("/uploads", uploads_service)
        .layer(cors)
        .with_state(state.clone());

    if state.config.static_dir.exists() {
        let index_file = state.config.static_dir.join("index.html");
        let spa_service =
            ServeDir::new(&state.config.static_dir).not_found_service(ServeFile::new(index_file));
        router = router.fallback_service(spa_service);
    }

    router
}
