use std::path::{Path, PathBuf};

pub fn app_data_dir() -> PathBuf {
    let mut path = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    path.push("My Translator");
    path
}

pub fn local_env_dir() -> PathBuf {
    app_data_dir().join("local-env")
}

pub fn venv_python_path(env_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        env_dir.join("Scripts").join("python.exe")
    } else {
        env_dir.join("bin").join("python3")
    }
}

pub fn setup_marker_path(env_dir: &Path) -> PathBuf {
    env_dir.join(".setup_complete")
}

pub fn resolve_script_candidates(script_rel_path: &str) -> Vec<PathBuf> {
    let script_basename = Path::new(script_rel_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(script_rel_path)
        .to_string();

    let mut candidates = vec![
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../scripts/{}", script_rel_path)),
        PathBuf::from(format!("scripts/{}", script_rel_path)),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../scripts/{}", script_basename)),
        PathBuf::from(format!("scripts/{}", script_basename)),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(format!("../Resources/scripts/{}", script_rel_path)));
            candidates.push(parent.join(format!("../Resources/scripts/{}", script_basename)));
        }
    }

    candidates
}

pub fn resolve_script(script_rel_path: &str) -> Result<PathBuf, String> {
    resolve_script_candidates(script_rel_path)
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| format!("Required script not found: {}", script_rel_path))
}