use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use chrono::Local;

/// Get the transcript directory path
fn transcript_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("transcripts");

    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create transcript dir: {}", e))?;
    Ok(dir)
}

/// Save a complete transcript session to a timestamped file
/// Called when user clicks "Clear", stops recording, or closes app
#[tauri::command]
pub fn save_transcript(app: AppHandle, content: String) -> Result<String, String> {
    let dir = transcript_dir(&app)?;
    let now = Local::now();
    let filename = format!("{}.md", now.format("%Y-%m-%d_%H-%M-%S"));
    let filepath = dir.join(&filename);

    fs::write(&filepath, content)
        .map_err(|e| format!("Failed to save transcript: {}", e))?;

    Ok(filepath.to_string_lossy().to_string())
}

/// Open the transcript directory in the system file manager
/// macOS: Finder, Windows: Explorer
#[tauri::command]
pub fn open_transcript_dir(app: AppHandle) -> Result<(), String> {
    let dir = transcript_dir(&app)?;

    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    std::process::Command::new(cmd)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Failed to open transcript dir: {}", e))?;
    Ok(())
}

/// Open the local app data directory, which contains the setup/pipeline log
#[tauri::command]
pub fn open_local_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("Failed to get app local data dir: {}", e))?;

    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create local data dir: {}", e))?;

    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    std::process::Command::new(cmd)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Failed to open local data dir: {}", e))?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct TranscriptMeta {
    pub filename: String,
    pub created_at: i64,
    pub path: String,
    pub preview: String,
    pub model: Option<String>,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
    pub recording_duration: Option<String>,
    pub audio_source: Option<String>,
    pub segments: Option<u32>,
}

fn split_frontmatter(content: &str) -> (HashMap<String, String>, String) {
    let mut metadata = HashMap::new();
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return (metadata, content.to_string());
    }

    let normalized = content.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next() != Some("---") {
        return (metadata, content.to_string());
    }

    let mut body_start = 0usize;
    let mut consumed = 4usize;
    let mut found_end = false;

    for line in lines {
        if line == "---" {
            found_end = true;
            body_start = consumed + 4;
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            metadata.insert(key.trim().to_string(), value.trim().to_string());
        }
        consumed += line.len() + 1;
    }

    if !found_end {
        return (HashMap::new(), content.to_string());
    }

    let body = normalized
        .get(body_start..)
        .unwrap_or_default()
        .trim()
        .to_string();
    (metadata, body)
}

#[tauri::command]
pub fn list_transcripts(app: AppHandle) -> Result<Vec<TranscriptMeta>, String> {
    let dir = transcript_dir(&app)?;
    let mut transcripts = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(metadata) = fs::metadata(&path) {
                    let created_at = metadata.created().map(|time| time.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64).unwrap_or(0);
                    let filename = path.file_name().unwrap().to_string_lossy().into_owned();
                    let content = fs::read_to_string(&path).unwrap_or_default();
                    let (frontmatter, body) = split_frontmatter(&content);
                    let preview_source = if body.trim().is_empty() { &content } else { &body };
                    let preview = preview_source.lines().take(5).collect::<Vec<_>>().join(" ");
                    transcripts.push(TranscriptMeta {
                        filename,
                        created_at,
                        path: path.to_string_lossy().into_owned(),
                        preview: preview.chars().take(100).collect(),
                        model: frontmatter.get("model").cloned(),
                        source_language: frontmatter.get("source_language").cloned(),
                        target_language: frontmatter.get("target_language").cloned(),
                        recording_duration: frontmatter.get("recording_duration").cloned(),
                        audio_source: frontmatter.get("audio_source").cloned(),
                        segments: frontmatter.get("segments").and_then(|value| value.parse::<u32>().ok()),
                    });
                }
            }
        }
    }
    transcripts.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(transcripts)
}

#[tauri::command]
pub fn get_transcript(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_transcript(path: String) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| e.to_string())
}
