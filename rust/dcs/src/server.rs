use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use dcs_core::manager::{ManagerError, SessionManager};
use dcs_core::model::{
    CleanStaleBody, CreateWorkspaceBody, ForkBody, HealthResponse, ImportWorkspacesBody,
    MemorySearchParams, NewSessionBody, PromoteSnapshotBody, RestoreBody, ResumeBatchBody,
    ResumeBody, SessionFilter, SessionLiveness, SessionPatch,
};
use dcs_core::paths::DcsPaths;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

pub type SharedManager = Arc<Mutex<SessionManager>>;

#[derive(Debug, Clone)]
pub struct ServerOptions {
    pub addr: SocketAddr,
    pub paths: DcsPaths,
}

pub async fn serve(options: ServerOptions) -> Result<(), Box<dyn std::error::Error>> {
    let manager = SessionManager::new(options.paths)?;
    let listener = tokio::net::TcpListener::bind(options.addr).await?;
    axum::serve(listener, router(Arc::new(Mutex::new(manager)))).await?;
    Ok(())
}

pub fn router(manager: SharedManager) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(get_config).put(update_config))
        .route("/api/stats", get(stats))
        .route("/api/logs", get(logs))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/stale", get(list_stale_sessions))
        .route("/api/sessions/clean", post(clean_stale))
        .route("/api/sessions/clean-stale", post(clean_stale))
        .route("/api/sessions/resume-batch", post(resume_batch))
        .route("/api/sessions/new", post(new_session))
        .route("/api/sessions/:id", get(get_session).patch(update_session))
        .route("/api/sessions/:id/resume", post(resume_session))
        .route("/api/sessions/:id/fork", post(fork_session))
        .route("/api/sessions/:id/transcript", get(transcript))
        .route("/api/sessions/:id/memories", get(session_memories))
        .route("/api/graph", get(graph))
        .route("/api/memory/reindex", post(memory_reindex))
        .route("/api/memory/search", get(memory_search))
        .route("/api/memory/related/:session_id", get(memory_related))
        .route("/api/memory/recall", get(memory_recall))
        .route("/api/memory/session/:id", get(session_memories))
        .route(
            "/api/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route("/api/workspaces/export", get(export_workspaces))
        .route("/api/workspaces/import", post(import_workspaces))
        .route("/api/workspaces/snapshot", post(snapshot))
        .route("/api/workspaces/snapshots", get(list_snapshots))
        .route("/api/snapshot", post(snapshot))
        .route("/api/snapshots", get(list_snapshots))
        .route(
            "/api/workspaces/restore-last",
            post(restore_latest_snapshot),
        )
        .route("/api/workspaces/promote-snapshot", post(promote_snapshot))
        .route(
            "/api/workspaces/:id",
            get(get_workspace).delete(delete_workspace),
        )
        .route(
            "/api/workspaces/:id/promote",
            post(promote_workspace_snapshot),
        )
        .route("/api/workspaces/:id/restore", post(restore_workspace))
        .route("/api/workspaces/:id/diff", get(workspace_diff))
        .fallback(api_not_found)
        .with_state(manager)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION").into(),
        now: now_iso(),
    })
}

async fn get_config(State(manager): State<SharedManager>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "config": manager.config() })).into_response())
    })
}

async fn update_config(State(manager): State<SharedManager>, Json(body): Json<Value>) -> ApiResult {
    with_manager_mut(&manager, |manager| {
        Ok(Json(json!({ "config": manager.update_config(body)? })).into_response())
    })
}

async fn stats(State(manager): State<SharedManager>) -> ApiResult {
    with_manager(
        &manager,
        |manager| Ok(Json(manager.stats()).into_response()),
    )
}

#[derive(Deserialize)]
struct LogsQuery {
    lines: Option<usize>,
    level: Option<String>,
}

async fn logs(State(manager): State<SharedManager>, Query(query): Query<LogsQuery>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(
            Json(json!({ "logs": manager.tail_logs(query.lines, query.level.as_deref()) }))
                .into_response(),
        )
    })
}

async fn list_sessions(
    State(manager): State<SharedManager>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let filter = session_filter(&query);
    with_manager(&manager, |manager| {
        Ok(Json(manager.list_sessions(filter)).into_response())
    })
}

async fn get_session(State(manager): State<SharedManager>, Path(id): Path<String>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(manager.get_session(&id)?).into_response())
    })
}

async fn list_stale_sessions(State(manager): State<SharedManager>) -> ApiResult {
    with_manager(&manager, |manager| {
        let sessions = manager
            .list_sessions(SessionFilter::All)
            .sessions
            .into_iter()
            .filter(|session| matches!(session.liveness, SessionLiveness::Stale))
            .collect::<Vec<_>>();
        Ok(Json(json!({ "sessions": sessions })).into_response())
    })
}

async fn update_session(
    State(manager): State<SharedManager>,
    Path(id): Path<String>,
    Json(body): Json<SessionPatch>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        let _managed = manager.update_session(&id, body)?;
        Ok(Json(json!({ "session": manager.get_session(&id)?.session })).into_response())
    })
}

async fn resume_session(
    State(manager): State<SharedManager>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    body: OptionJson<ResumeBody>,
) -> ApiResult {
    let dry_run = bool_query(&query, "dryRun");
    let body = body.0.unwrap_or(ResumeBody {
        window: None,
        color: None,
        title: None,
        cwd: None,
    });
    with_manager(&manager, |manager| {
        Ok(Json(manager.resume_session(&id, body, dry_run)?).into_response())
    })
}

async fn resume_batch(
    State(manager): State<SharedManager>,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<ResumeBatchBody>,
) -> ApiResult {
    let dry_run = bool_query(&query, "dryRun");
    with_manager(&manager, |manager| {
        Ok(Json(manager.resume_batch(body, dry_run)?).into_response())
    })
}

async fn new_session(
    State(manager): State<SharedManager>,
    Query(query): Query<HashMap<String, String>>,
    Json(body): Json<NewSessionBody>,
) -> ApiResult {
    let dry_run = bool_query(&query, "dryRun");
    with_manager(&manager, |manager| {
        Ok(Json(manager.new_session(body, dry_run)?).into_response())
    })
}

async fn fork_session(
    State(manager): State<SharedManager>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    body: OptionJson<ForkBody>,
) -> ApiResult {
    let dry_run = bool_query(&query, "dryRun");
    let body = body.0.unwrap_or(ForkBody {
        note: None,
        launch: None,
        color: None,
        window: None,
    });
    with_manager(&manager, |manager| {
        Ok(Json(manager.fork_session(&id, body, dry_run)?).into_response())
    })
}

async fn transcript(State(manager): State<SharedManager>, Path(id): Path<String>) -> ApiResult {
    with_manager(&manager, |manager| {
        let mut response = Response::new(Body::from(manager.transcript(&id)));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/markdown; charset=utf-8"),
        );
        Ok(response)
    })
}

async fn session_memories(
    State(manager): State<SharedManager>,
    Path(id): Path<String>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "memories": manager.memories_for_session(&id) })).into_response())
    })
}

async fn graph(
    State(manager): State<SharedManager>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let filter = session_filter(&query);
    with_manager(&manager, |manager| {
        Ok(Json(manager.graph(filter)).into_response())
    })
}

async fn clean_stale(
    State(manager): State<SharedManager>,
    body: OptionJson<CleanStaleBody>,
) -> ApiResult {
    let body = body.0.unwrap_or(CleanStaleBody {
        remove: Some(false),
    });
    with_manager(&manager, |manager| {
        Ok(Json(manager.clean_stale(body)).into_response())
    })
}

async fn memory_reindex(State(manager): State<SharedManager>) -> ApiResult {
    with_manager_mut(&manager, |manager| {
        let count = manager.reindex_memory()?;
        Ok(Json(json!({ "count": count })).into_response())
    })
}

async fn memory_search(
    State(manager): State<SharedManager>,
    Query(params): Query<MemorySearchParams>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "hits": manager.search_memory(params) })).into_response())
    })
}

async fn memory_related(
    State(manager): State<SharedManager>,
    Path(session_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<u32>().ok());
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "memories": manager.related_memory(&session_id, limit) })).into_response())
    })
}

async fn memory_recall(
    State(manager): State<SharedManager>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let repository = query.get("repository").map(String::as_str);
    let branch = query.get("branch").map(String::as_str);
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<u32>().ok());
    with_manager(&manager, |manager| {
        Ok(
            Json(json!({ "pack": manager.recall_memory(repository, branch, limit) }))
                .into_response(),
        )
    })
}

async fn list_workspaces(State(manager): State<SharedManager>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "workspaces": manager.list_workspaces() })).into_response())
    })
}

async fn get_workspace(State(manager): State<SharedManager>, Path(id): Path<String>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "workspace": manager.get_workspace(&id)? })).into_response())
    })
}

async fn create_workspace(
    State(manager): State<SharedManager>,
    Json(body): Json<CreateWorkspaceBody>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok((
            StatusCode::CREATED,
            Json(json!({ "workspace": manager.create_workspace(body)? })),
        )
            .into_response())
    })
}

async fn delete_workspace(
    State(manager): State<SharedManager>,
    Path(id): Path<String>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        manager.delete_workspace(&id)?;
        Ok(Json(json!({ "ok": true })).into_response())
    })
}

async fn export_workspaces(State(manager): State<SharedManager>) -> ApiResult {
    with_manager(&manager, |manager| {
        let mut response = Response::new(Body::from(manager.export_workspaces()?));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        Ok(response)
    })
}

async fn import_workspaces(
    State(manager): State<SharedManager>,
    Json(body): Json<ImportWorkspacesBody>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "workspaces": manager.import_workspaces(body)? })).into_response())
    })
}

async fn snapshot(State(manager): State<SharedManager>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "workspace": manager.snapshot()? })).into_response())
    })
}

async fn list_snapshots(State(manager): State<SharedManager>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(json!({ "snapshots": manager.list_snapshots() })).into_response())
    })
}

async fn restore_workspace(
    State(manager): State<SharedManager>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    body: OptionJson<RestoreBody>,
) -> ApiResult {
    let dry_run = bool_query(&query, "dryRun");
    let body = body.0.unwrap_or(RestoreBody { window: None });
    with_manager(&manager, |manager| {
        Ok(Json(manager.restore_workspace(&id, body.window, dry_run)?).into_response())
    })
}

async fn restore_latest_snapshot(
    State(manager): State<SharedManager>,
    Query(query): Query<HashMap<String, String>>,
    body: OptionJson<RestoreBody>,
) -> ApiResult {
    let dry_run = bool_query(&query, "dryRun");
    let body = body.0.unwrap_or(RestoreBody { window: None });
    with_manager(&manager, |manager| {
        Ok(Json(manager.restore_latest_snapshot(body.window, dry_run)?).into_response())
    })
}

async fn promote_snapshot(
    State(manager): State<SharedManager>,
    Json(body): Json<PromoteSnapshotBody>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok((
            StatusCode::CREATED,
            Json(json!({ "workspace": manager.promote_snapshot(body.name)? })),
        )
            .into_response())
    })
}

async fn promote_workspace_snapshot(
    State(manager): State<SharedManager>,
    Path(_id): Path<String>,
    Json(body): Json<PromoteSnapshotBody>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok((
            StatusCode::CREATED,
            Json(json!({ "workspace": manager.promote_snapshot(body.name)? })),
        )
            .into_response())
    })
}

async fn workspace_diff(State(manager): State<SharedManager>, Path(id): Path<String>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(manager.workspace_diff(&id)?).into_response())
    })
}

async fn api_not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" })))
}

type ApiResult = Result<Response, ApiError>;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<ManagerError> for ApiError {
    fn from(error: ManagerError) -> Self {
        let status = match error {
            ManagerError::MissingSession(_) | ManagerError::MissingWorkspace(_) => {
                StatusCode::NOT_FOUND
            }
            ManagerError::InvalidInput(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            message: error.to_string(),
        }
    }
}

fn with_manager<F>(manager: &SharedManager, f: F) -> ApiResult
where
    F: FnOnce(&SessionManager) -> Result<Response, ManagerError>,
{
    let guard = manager.lock().map_err(|_| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "Manager lock poisoned".into(),
    })?;
    f(&guard).map_err(ApiError::from)
}

fn with_manager_mut<F>(manager: &SharedManager, f: F) -> ApiResult
where
    F: FnOnce(&mut SessionManager) -> Result<Response, ManagerError>,
{
    let mut guard = manager.lock().map_err(|_| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "Manager lock poisoned".into(),
    })?;
    f(&mut guard).map_err(ApiError::from)
}

fn session_filter(query: &HashMap<String, String>) -> SessionFilter {
    match query.get("filter").map(String::as_str) {
        Some("all") => SessionFilter::All,
        Some("live") => SessionFilter::Live,
        _ => SessionFilter::Open,
    }
}

fn bool_query(query: &HashMap<String, String>, key: &str) -> bool {
    query
        .get(key)
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

struct OptionJson<T>(Option<T>);

#[axum::async_trait]
impl<S, T> axum::extract::FromRequest<S> for OptionJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, Self::Rejection> {
        if req
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            == Some("0")
        {
            return Ok(Self(None));
        }
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(Some(value))),
            Err(rejection) if rejection.status() == StatusCode::UNSUPPORTED_MEDIA_TYPE => {
                Ok(Self(None))
            }
            Err(rejection) if rejection.status() == StatusCode::BAD_REQUEST => Err(ApiError {
                status: StatusCode::BAD_REQUEST,
                message: rejection.body_text(),
            }),
            Err(rejection) => Err(ApiError {
                status: rejection.status(),
                message: rejection.body_text(),
            }),
        }
    }
}
