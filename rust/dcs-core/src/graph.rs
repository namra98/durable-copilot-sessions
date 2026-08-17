use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::model::{
    AppConfig, ColorStrategy, DiscoveredSession, GraphEdge, GraphEdgeKind, GraphModel, GraphNode,
    ManagedSession, SessionLiveness, SessionRole, TabSpec, WindowGrouping, WindowSpec,
};

const PALETTE: &[&str] = &[
    "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#06B6D4", "#84CC16",
    "#F97316", "#14B8A6", "#A855F7", "#EAB308",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAnnotation {
    pub role_by_id: BTreeMap<String, SessionRole>,
    pub group_pid_by_id: BTreeMap<String, u32>,
    pub children_by_id: BTreeMap<String, Vec<String>>,
    pub open_count: u32,
}

pub fn annotate_open(sessions: &[DiscoveredSession]) -> OpenAnnotation {
    let live = sessions
        .iter()
        .filter(|session| {
            matches!(session.liveness, SessionLiveness::Live) && !session.live_pids.is_empty()
        })
        .collect::<Vec<_>>();
    let mut pid_to_sessions: BTreeMap<u32, Vec<&DiscoveredSession>> = BTreeMap::new();
    for session in live {
        for pid in &session.live_pids {
            pid_to_sessions.entry(*pid).or_default().push(session);
        }
    }

    let mut primary_id_by_pid = BTreeMap::new();
    for (pid, list) in &pid_to_sessions {
        let mut best = list[0];
        for session in list {
            if primary_rank(session) >= primary_rank(best) {
                best = session;
            }
        }
        primary_id_by_pid.insert(*pid, best.id.clone());
    }

    let primary_ids = primary_id_by_pid.values().cloned().collect::<BTreeSet<_>>();
    let mut role_by_id = BTreeMap::new();
    let mut group_pid_by_id = BTreeMap::new();
    let mut children_by_id = BTreeMap::new();

    for sessions in pid_to_sessions.values() {
        for session in sessions {
            if primary_ids.contains(&session.id) {
                role_by_id.insert(session.id.clone(), SessionRole::Primary);
                if let Some(pid) = session
                    .live_pids
                    .iter()
                    .find(|pid| primary_id_by_pid.get(pid) == Some(&session.id))
                {
                    group_pid_by_id.insert(session.id.clone(), *pid);
                }
                children_by_id
                    .entry(session.id.clone())
                    .or_insert_with(Vec::new);
            } else {
                role_by_id.insert(session.id.clone(), SessionRole::Child);
                if let Some(pid) = session.live_pids.first() {
                    group_pid_by_id.insert(session.id.clone(), *pid);
                }
            }
        }
    }

    for sessions in pid_to_sessions.values() {
        for session in sessions {
            if role_by_id.get(&session.id) != Some(&SessionRole::Child) {
                continue;
            }
            for pid in &session.live_pids {
                if let Some(primary_id) = primary_id_by_pid.get(pid) {
                    if primary_id != &session.id {
                        let kids = children_by_id.entry(primary_id.clone()).or_default();
                        if !kids.iter().any(|id| id == &session.id) {
                            kids.push(session.id.clone());
                        }
                        break;
                    }
                }
            }
        }
    }

    OpenAnnotation {
        role_by_id,
        group_pid_by_id,
        children_by_id,
        open_count: primary_ids.len().min(u32::MAX as usize) as u32,
    }
}

pub fn build_graph(
    sessions: &[DiscoveredSession],
    managed_by_id: &HashMap<String, ManagedSession>,
    config: &AppConfig,
) -> GraphModel {
    let annotation = annotate_open(sessions);
    let ids = sessions
        .iter()
        .map(|session| session.id.clone())
        .collect::<HashSet<_>>();
    let nodes = sessions
        .iter()
        .map(|session| {
            let managed = managed_by_id.get(&session.id);
            GraphNode {
                id: session.id.clone(),
                label: managed
                    .and_then(|managed| managed.title.clone())
                    .or_else(|| session.name.clone())
                    .unwrap_or_else(|| session.id.chars().take(8).collect()),
                repository: session.repository.clone(),
                branch: session.branch.clone(),
                cwd: session.cwd.clone(),
                color: Some(tab_for(session, managed, config).color),
                liveness: session.liveness,
                role: annotation.role_by_id.get(&session.id).copied(),
                is_fork: session
                    .branch_of
                    .as_ref()
                    .map(|value| !value.is_empty())
                    .unwrap_or(false),
                child_count: annotation
                    .children_by_id
                    .get(&session.id)
                    .map(|children| children.len().min(u32::MAX as usize) as u32)
                    .unwrap_or(0),
            }
        })
        .collect();

    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    for session in sessions {
        if let Some(parent) = &session.branch_of {
            if ids.contains(parent) {
                push_edge(
                    &mut edges,
                    &mut seen,
                    GraphEdge {
                        id: format!("fork:{parent}->{}", session.id),
                        source: parent.clone(),
                        target: session.id.clone(),
                        kind: GraphEdgeKind::Fork,
                    },
                );
            }
        }
    }
    for (primary_id, child_ids) in &annotation.children_by_id {
        if !ids.contains(primary_id) {
            continue;
        }
        for child_id in child_ids {
            if ids.contains(child_id) {
                push_edge(
                    &mut edges,
                    &mut seen,
                    GraphEdge {
                        id: format!("terminal:{primary_id}->{child_id}"),
                        source: primary_id.clone(),
                        target: child_id.clone(),
                        kind: GraphEdgeKind::Terminal,
                    },
                );
            }
        }
    }

    GraphModel {
        nodes,
        edges,
        open_count: annotation.open_count,
    }
}

pub fn build_windows(
    sessions: &[DiscoveredSession],
    managed_by_id: &HashMap<String, ManagedSession>,
    config: &AppConfig,
) -> Vec<WindowSpec> {
    let mut groups: BTreeMap<String, Vec<TabSpec>> = BTreeMap::new();
    for session in sessions {
        let key = group_key_for(session, config.window_grouping);
        groups.entry(key).or_default().push(tab_for(
            session,
            managed_by_id.get(&session.id),
            config,
        ));
    }
    groups
        .into_iter()
        .enumerate()
        .map(|(index, (label, tabs))| WindowSpec {
            id: format!("w{index}"),
            label: Some(label),
            tabs,
        })
        .collect()
}

pub fn tab_for(
    session: &DiscoveredSession,
    managed: Option<&ManagedSession>,
    config: &AppConfig,
) -> TabSpec {
    TabSpec {
        session_id: session.id.clone(),
        title: managed
            .and_then(|managed| managed.title.clone())
            .or_else(|| session.name.clone())
            .unwrap_or_else(|| session.id.chars().take(8).collect()),
        color: managed
            .and_then(|managed| managed.color.clone())
            .unwrap_or_else(|| color_for(session, config.color_strategy)),
        cwd: session.cwd.clone(),
        copilot_args: None,
    }
}

fn push_edge(edges: &mut Vec<GraphEdge>, seen: &mut HashSet<String>, edge: GraphEdge) {
    if seen.insert(edge.id.clone()) {
        edges.push(edge);
    }
}

fn assign_color(key: &str) -> String {
    let mut hash = 0u32;
    for byte in key.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(byte));
    }
    PALETTE[(hash as usize) % PALETTE.len()].into()
}

fn color_for(session: &DiscoveredSession, strategy: ColorStrategy) -> String {
    match strategy {
        ColorStrategy::ByCwd => {
            assign_color(&fallback_key([Some(&session.cwd), Some(&session.id)]))
        }
        ColorStrategy::Rotate => assign_color(&session.id),
        ColorStrategy::Fixed => PALETTE[0].into(),
        ColorStrategy::ByRepo => assign_color(&fallback_key([
            session.repository.as_ref(),
            session.git_root.as_ref(),
            Some(&session.cwd),
            Some(&session.id),
        ])),
    }
}

fn group_key_for(session: &DiscoveredSession, grouping: WindowGrouping) -> String {
    match grouping {
        WindowGrouping::Single => "all".into(),
        WindowGrouping::ByCwd => non_empty(&session.cwd).unwrap_or_else(|| "unknown".into()),
        WindowGrouping::ByRepo => fallback_key([
            session.repository.as_ref(),
            session.git_root.as_ref(),
            Some(&session.cwd),
        ]),
    }
}

fn fallback_key<'a>(values: impl IntoIterator<Item = Option<&'a String>>) -> String {
    values
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| "unknown".into())
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

fn updated_millis(session: &DiscoveredSession) -> i64 {
    session
        .updated_at
        .as_ref()
        .and_then(|value| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(|value| value.unix_timestamp())
        .unwrap_or(0)
}

fn primary_rank(session: &DiscoveredSession) -> (u8, i64) {
    (u8::from(session.top_level), updated_millis(session))
}
