use std::fs;
use std::path::Path;

use serde_json::Value;

const DEFAULT_MAX_CHARS: usize = 8000;

pub fn export_transcript(session_state_dir: impl AsRef<Path>, session_id: &str) -> String {
    export_transcript_with_limit(session_state_dir, session_id, DEFAULT_MAX_CHARS)
}

pub fn export_transcript_with_limit(
    session_state_dir: impl AsRef<Path>,
    session_id: &str,
    max_chars: usize,
) -> String {
    let file = session_state_dir
        .as_ref()
        .join(session_id)
        .join("events.jsonl");
    let Ok(raw) = fs::read_to_string(file) else {
        return format!("# Transcript\n\nNo transcript found for {session_id}\n");
    };
    let mut sections = vec![format!("# Transcript: {session_id}\n")];
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Ok(Value::Object(event)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let heading = match event.get("type").and_then(Value::as_str) {
            Some("user.message") => "### You",
            Some("assistant.message") => "### Copilot",
            _ => continue,
        };
        let text = extract_text(&event).trim().to_owned();
        if text.is_empty() {
            continue;
        }
        sections.push(format!("{heading}\n\n{}\n", truncate(&text, max_chars)));
    }
    sections.join("\n")
}

fn extract_text(event: &serde_json::Map<String, Value>) -> String {
    if let Some(value) = event.get("data") {
        if let Some(text) = value.as_str() {
            return text.into();
        }
        if let Some(object) = value.as_object() {
            for key in ["text", "content", "message"] {
                if let Some(text) = object.get(key).and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        return text.into();
                    }
                }
            }
            for value in object.values() {
                if let Some(text) = value.as_str() {
                    if !text.trim().is_empty() {
                        return text.into();
                    }
                }
            }
        }
    }
    for key in ["text", "content", "message"] {
        if let Some(text) = event.get(key).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.into();
            }
        }
    }
    String::new()
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.into();
    }
    let mut out = text.chars().take(max_chars).collect::<String>();
    out.push_str("...");
    out
}
