use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use dcs_core::manager::{ManagerError, SessionManager};
use dcs_core::model::{
    CleanStaleBody, CreateWorkspaceBody, ForkBody, HealthResponse, ImportWorkspacesBody,
    MemorySearchParams, NewSessionBody, PromoteSnapshotBody, RestoreBody, ResumeBatchBody,
    ResumeBody, SessionFilter, SessionLiveness, SessionPatch, Workspace,
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
        .route("/", get(restore_prompt_page))
        .route("/restore-prompt", get(restore_prompt_page))
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
        .route_layer(middleware::from_fn(local_mutation_guard))
        .with_state(manager)
}

async fn local_mutation_guard(req: Request<Body>, next: Next) -> Response {
    if is_safe_method(req.method()) || is_allowed_local_mutation(req.headers()) {
        return next.run(req).await;
    }
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "Cross-site mutation requests are not allowed" })),
    )
        .into_response()
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION").into(),
        now: now_iso(),
    })
}

async fn restore_prompt_page(State(manager): State<SharedManager>) -> ApiResult {
    with_manager(&manager, |manager| match manager.latest_snapshot() {
        Ok(snapshot) => Ok(Html(render_restore_prompt(Some(&snapshot))).into_response()),
        Err(ManagerError::MissingWorkspace(_)) => {
            Ok(Html(render_restore_prompt(None)).into_response())
        }
        Err(error) => Err(error),
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
        confirm_copilot_state_write: None,
    });
    with_manager(&manager, |manager| {
        Ok(Json(manager.fork_session(&id, body, dry_run)?).into_response())
    })
}

async fn transcript(State(manager): State<SharedManager>, Path(id): Path<String>) -> ApiResult {
    with_manager(&manager, |manager| {
        let mut response = Response::new(Body::from(manager.transcript(&id)?));
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
        confirm_copilot_state_write: None,
    });
    with_manager(&manager, |manager| {
        Ok(Json(manager.clean_stale(body)?).into_response())
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

#[derive(Deserialize)]
struct ExportWorkspacesQuery {
    ids: Option<String>,
}

async fn export_workspaces(
    State(manager): State<SharedManager>,
    Query(query): Query<ExportWorkspacesQuery>,
) -> ApiResult {
    let ids = parse_ids(query.ids.as_deref());
    with_manager(&manager, |manager| {
        let mut response = Response::new(Body::from(manager.export_workspaces(ids.as_deref())?));
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
            Json(json!({ "workspace": manager.promote_latest_snapshot(body.name)? })),
        )
            .into_response())
    })
}

async fn promote_workspace_snapshot(
    State(manager): State<SharedManager>,
    Path(id): Path<String>,
    Json(body): Json<PromoteSnapshotBody>,
) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok((
            StatusCode::CREATED,
            Json(json!({ "workspace": manager.promote_snapshot(&id, body.name)? })),
        )
            .into_response())
    })
}

async fn workspace_diff(State(manager): State<SharedManager>, Path(id): Path<String>) -> ApiResult {
    with_manager(&manager, |manager| {
        Ok(Json(manager.workspace_diff(&id)?).into_response())
    })
}

fn render_restore_prompt(snapshot: Option<&Workspace>) -> String {
    let (summary, button_disabled) = match snapshot {
        Some(snapshot) => {
            let window_count = snapshot.windows.len();
            let tab_count = snapshot
                .windows
                .iter()
                .map(|window| window.tabs.len())
                .sum::<usize>();
            (
                format!(
                    r#"<p><strong>{}</strong></p><p>{} session(s) across {} window(s), captured at {}.</p>"#,
                    html_escape(&snapshot.name),
                    tab_count,
                    window_count,
                    html_escape(&snapshot.created_at)
                ),
                "",
            )
        }
        None => (
            "<p>No snapshot is available yet. Run <code>dcs snapshot</code> after opening sessions.</p>"
                .to_owned(),
            " disabled",
        ),
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Restore Copilot sessions</title>
  <style>
    :root {{ color-scheme: light dark; font-family: "Segoe UI", system-ui, sans-serif; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; }}
    main {{ width: min(42rem, calc(100vw - 2rem)); padding: 2rem; border: 1px solid #334155; border-radius: 1rem; background: #111827; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35); }}
    h1 {{ margin-top: 0; font-size: 1.75rem; }}
    p {{ line-height: 1.55; color: #cbd5e1; }}
    button {{ margin-top: 1rem; border: 0; border-radius: 0.75rem; padding: 0.85rem 1rem; font-weight: 700; background: #38bdf8; color: #082f49; cursor: pointer; }}
    button:disabled {{ opacity: 0.5; cursor: not-allowed; }}
    code {{ border-radius: 0.35rem; padding: 0.1rem 0.3rem; background: #1e293b; }}
    #status {{ min-height: 1.5rem; }}
  </style>
</head>
<body>
  <main>
    <h1>Restore your last Copilot session layout?</h1>
    {}
    <button id="restore"{}>Restore latest snapshot</button>
    <p id="status" role="status"></p>
  </main>
  <script>
    const button = document.getElementById("restore");
    const status = document.getElementById("status");
    button?.addEventListener("click", async () => {{
      button.disabled = true;
      status.textContent = "Launching Windows Terminal...";
      try {{
        const response = await fetch("/api/workspaces/restore-last", {{
          method: "POST",
          headers: {{ "content-type": "application/json" }},
          body: "{{}}"
        }});
        if (!response.ok) {{
          const body = await response.text();
          throw new Error(body || `HTTP ${{response.status}}`);
        }}
        status.textContent = "Restore launched. You can close this tab.";
      }} catch (error) {{
        button.disabled = false;
        status.textContent = `Restore failed: ${{error instanceof Error ? error.message : String(error)}}`;
      }}
    }});
  </script>
</body>
</html>"#,
        summary, button_disabled
    )
}

fn html_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
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

fn parse_ids(ids: Option<&str>) -> Option<Vec<String>> {
    ids.map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>()
    })
    .filter(|ids| !ids.is_empty())
}

fn is_safe_method(method: &Method) -> bool {
    method == Method::GET || method == Method::HEAD || method == Method::OPTIONS
}

fn is_allowed_local_mutation(headers: &HeaderMap) -> bool {
    if header_value(headers, "sec-fetch-site")
        .map(|value| value.eq_ignore_ascii_case("cross-site"))
        .unwrap_or(false)
    {
        return false;
    }
    if let Some(origin) = header_value(headers, header::ORIGIN.as_str()) {
        if !is_loopback_origin(origin) {
            return false;
        }
    }
    if let Some(referer) = header_value(headers, header::REFERER.as_str()) {
        if !is_loopback_origin(referer) {
            return false;
        }
    }
    true
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn is_loopback_origin(value: &str) -> bool {
    let Ok(uri) = value.parse::<Uri>() else {
        return false;
    };
    matches!(
        uri.host(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]")
    )
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
