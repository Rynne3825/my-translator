use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use tauri::ipc::Channel;

/// State for the local pipeline sidecar process
pub struct LocalPipelineState {
    pub process: Mutex<Option<Child>>,
}

static LOCAL_SETUP_RUNNING: LazyLock<Mutex<bool>> = LazyLock::new(|| Mutex::new(false));

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}", now)
}

fn app_data_dir() -> PathBuf {
    let mut path = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    path.push("My Translator");
    path
}

fn log_path() -> PathBuf {
    app_data_dir().join("local_pipeline.log")
}

fn log_to_file(msg: &str) {
    use std::fs::OpenOptions;

    if let Some(parent) = log_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let _ = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
        .and_then(|mut f| writeln!(f, "[{}] {}", chrono_now(), msg));
    eprintln!("[local-pipeline] {}", msg);
}

fn local_env_dir() -> PathBuf {
    app_data_dir().join("local-env")
}

fn venv_python_path(env_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        env_dir.join("Scripts").join("python.exe")
    } else {
        env_dir.join("bin").join("python3")
    }
}

fn setup_marker_path(env_dir: &Path) -> PathBuf {
    env_dir.join(".setup_complete")
}

fn resolve_script(script_rel_path: &str) -> Result<PathBuf, String> {
    let script_basename = Path::new(script_rel_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(script_rel_path)
        .to_string();

    let mut candidates = vec![
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../scripts/{}", script_rel_path)),
        std::path::PathBuf::from(format!("scripts/{}", script_rel_path)),
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../scripts/{}", script_basename)),
        std::path::PathBuf::from(format!("scripts/{}", script_basename)),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(format!("../Resources/scripts/{}", script_rel_path)));
            candidates.push(parent.join(format!("../Resources/scripts/{}", script_basename)));
        }
    }

    log_to_file(&format!(
        "Checking script candidates for {}: {:?}",
        script_rel_path,
        candidates
            .iter()
            .map(|p| format!("{:?} exists={}", p, p.exists()))
            .collect::<Vec<_>>()
    ));

    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| format!("Required script not found: {}", script_rel_path))
}

fn local_backend_kind() -> &'static str {
    "whisper"
}

fn pipeline_script_name() -> &'static str {
    "runtime/local_whisper_pipeline.py"
}

fn setup_script_name() -> &'static str {
    "setup/setup_local_whisper.py"
}

fn python_command_string() -> String {
    let env_dir = local_env_dir();
    let venv_python = venv_python_path(&env_dir);
    if venv_python.exists() {
        return venv_python.to_string_lossy().into_owned();
    }

    if cfg!(target_os = "windows") {
        "python".to_string()
    } else if Path::new("/opt/homebrew/bin/python3").exists() {
        "/opt/homebrew/bin/python3".to_string()
    } else if Path::new("/usr/local/bin/python3").exists() {
        "/usr/local/bin/python3".to_string()
    } else {
        "python3".to_string()
    }
}

fn system_python_command() -> (String, Vec<String>) {
    if cfg!(target_os = "windows") {
        let python_ok = Command::new("python")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if python_ok {
            ("python".to_string(), vec![])
        } else {
            ("py".to_string(), vec!["-3".to_string()])
        }
    } else if Path::new("/opt/homebrew/bin/python3").exists() {
        ("/opt/homebrew/bin/python3".to_string(), vec![])
    } else if Path::new("/usr/local/bin/python3").exists() {
        ("/usr/local/bin/python3".to_string(), vec![])
    } else {
        ("python3".to_string(), vec![])
    }
}

fn python_candidates_report() -> String {
    #[cfg(target_os = "windows")]
    {
        let mut versions: Vec<String> = Vec::new();

        if let Ok(output) = Command::new("py").arg("-0p").output() {
            let text = String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr);
            for line in text.lines() {
                if let Some(idx) = line.find("-V:") {
                    let rest = &line[idx + 3..];
                    if let Some(version) = rest.split_whitespace().next() {
                        versions.push(version.trim().to_string());
                    }
                }
            }
        }

        if let Ok(output) = Command::new("python").arg("--version").output() {
            let text = String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr);
            for line in text.lines() {
                if let Some(version) = line.strip_prefix("Python ") {
                    versions.push(version.trim().to_string());
                }
            }
        }

        versions.sort();
        versions.dedup();

        let supported = versions.iter().any(|v| {
            v.starts_with("3.10.") || v.starts_with("3.11.") || v.starts_with("3.12.")
        });

        let versions_json = serde_json::to_string(&versions).unwrap_or_else(|_| "[]".to_string());
        return format!(r#"{{"versions":{},"supported":{}}}"#, versions_json, supported);
    }

    #[cfg(not(target_os = "windows"))]
    {
        r#"{"versions":[],"supported":true}"#.to_string()
    }
}

fn detect_local_env_lock_report() -> String {
    #[cfg(target_os = "windows")]
    {
        let env_path = local_env_dir().to_string_lossy().replace('\\', "\\\\");
        let script = format!(
            "$p='{}'; Get-CimInstance Win32_Process | Where-Object {{ ($_.Name -match '^(python|py)\\.exe$') -and $_.CommandLine -and ($_.CommandLine -like \"*${{p}}*\") }} | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
            env_path
        );

        if let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                return r#"{"in_use":false,"processes":[]}"#.to_string();
            }
            return format!(r#"{{"in_use":true,"processes":{}}}"#, stdout);
        }

        return r#"{"in_use":false,"processes":[]}"#.to_string();
    }

    #[cfg(not(target_os = "windows"))]
    {
        r#"{"in_use":false,"processes":[]}"#.to_string()
    }
}

#[cfg(target_os = "windows")]
fn local_env_lock_processes() -> Vec<u32> {
    let env_path = local_env_dir().to_string_lossy().replace('\\', "\\\\");
    let script = format!(
        "$p='{}'; Get-CimInstance Win32_Process | Where-Object {{ ($_.Name -match '^(python|py)\\.exe$') -and $_.CommandLine -and ($_.CommandLine -like \"*${{p}}*\") }} | ForEach-Object {{ $_.ProcessId }}",
        env_path
    );

    if let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
    {
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .collect();
    }

    Vec::new()
}

/// Start the local translation pipeline (Python sidecar)
#[tauri::command]
pub fn start_local_pipeline(
    source_lang: String,
    target_lang: String,
    local_model: Option<String>,
    initial_prompt: Option<String>,
    hotwords: Option<Vec<String>>,
    channel: Channel<String>,
    state: tauri::State<'_, LocalPipelineState>,
) -> Result<(), String> {
    log_to_file(&format!(
        "start_local_pipeline called: backend={}, src={}, tgt={}",
        local_backend_kind(),
        source_lang,
        target_lang
    ));

    let _ = channel.send(r#"{"type":"status","message":"Stopping old pipeline..."}"#.to_string());
    stop_local_pipeline_inner(&state);
    std::thread::sleep(std::time::Duration::from_millis(250));

    if !cfg!(target_os = "macos") || !cfg!(target_arch = "aarch64") {
        let env_dir = local_env_dir();
        let marker = setup_marker_path(&env_dir);
        let python = venv_python_path(&env_dir);
        if !marker.exists() || !python.exists() {
            return Err("Faster-Whisper Realtime is not set up yet. Run local setup first.".to_string());
        }
    }

    let script_path = resolve_script(pipeline_script_name())?;
    let python = python_command_string();
    let env_dir = local_env_dir();
    let local_model = local_model.unwrap_or_else(|| "turbo".to_string());

    let _ = channel.send(format!(
        r#"{{"type":"status","message":"Starting local pipeline ({})..."}}"#,
        local_backend_kind()
    ));

    let mut cmd = Command::new(&python);
    cmd.arg(&script_path)
        .arg("--source-lang")
        .arg(&source_lang)
        .arg("--target-lang")
        .arg(&target_lang)
        .arg("--model")
        .arg(&local_model)
        .env("TOKENIZERS_PARALLELISM", "false")
        .env("MY_TRANSLATOR_ENV_DIR", env_dir.to_string_lossy().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(prompt) = initial_prompt {
        let normalized = prompt.trim().to_string();
        if !normalized.is_empty() {
            cmd.arg("--initial-prompt").arg(normalized);
        }
    }

    if let Some(hotwords) = hotwords {
        let normalized: Vec<String> = hotwords
            .into_iter()
            .map(|word| word.trim().to_string())
            .filter(|word| !word.is_empty())
            .collect();
        if !normalized.is_empty() {
            cmd.arg("--hotwords").arg(normalized.join(","));
        }
    }

    if !cfg!(target_os = "windows") {
        cmd.env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    }

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("Failed to start local pipeline with {}: {}", python, e);
        log_to_file(&msg);
        msg
    })?;

    log_to_file(&format!(
        "Python process spawned, PID={}, script={:?}",
        child.id(),
        script_path
    ));

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            if let Ok(mut guard) = LOCAL_SETUP_RUNNING.lock() {
                *guard = false;
            }
            return Err("Failed to get stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            if let Ok(mut guard) = LOCAL_SETUP_RUNNING.lock() {
                *guard = false;
            }
            return Err("Failed to get stderr".to_string());
        }
    };

    let channel_clone = channel.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) if !line.is_empty() => {
                    log_to_file(&format!("stdout: {}", &line));
                    let _ = channel_clone.send(line);
                }
                Err(e) => {
                    log_to_file(&format!("stdout error: {}", e));
                    break;
                }
                _ => {}
            }
        }
        log_to_file("stdout reader ended");
    });

    let channel_clone2 = channel.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    log_to_file(&format!("stderr: {}", line));
                    let escaped = line.replace('"', r#"\""#);
                    let _ = channel_clone2.send(format!(
                        r#"{{"type":"status","message":"{}"}}"#,
                        escaped
                    ));
                }
                Err(_) => break,
            }
        }
        log_to_file("stderr reader ended");
    });

    let mut proc = state.process.lock().map_err(|e| e.to_string())?;
    *proc = Some(child);
    Ok(())
}

/// Send audio data to the local pipeline stdin
#[tauri::command]
pub fn send_audio_to_pipeline(
    data: Vec<u8>,
    state: tauri::State<'_, LocalPipelineState>,
) -> Result<(), String> {
    let mut proc = state.process.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *proc {
        if let Some(ref mut stdin) = child.stdin {
            if let Err(e) = stdin.write_all(&data) {
                log_to_file(&format!("stdin write error: {}", e));
                let mut child = proc.take();
                if let Some(ref mut process) = child {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                return Err("Local pipeline closed".to_string());
            }
            if let Err(e) = stdin.flush() {
                log_to_file(&format!("stdin flush error: {}", e));
                let mut child = proc.take();
                if let Some(ref mut process) = child {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                return Err("Local pipeline closed".to_string());
            }
        }
    }
    Ok(())
}

/// Stop the local pipeline
#[tauri::command]
pub fn stop_local_pipeline(state: tauri::State<'_, LocalPipelineState>) -> Result<(), String> {
    log_to_file("stop_local_pipeline called");
    stop_local_pipeline_inner(&state);
    Ok(())
}

fn stop_local_pipeline_inner(state: &LocalPipelineState) {
    if let Ok(mut proc) = state.process.lock() {
        if let Some(mut child) = proc.take() {
            log_to_file(&format!("Stopping pipeline PID={}", child.id()));
            drop(child.stdin.take());
            std::thread::sleep(std::time::Duration::from_millis(250));
            let _ = child.kill();
            let _ = child.wait();
            log_to_file("Pipeline stopped");
        }
    }
}

/// Check if local setup is complete
#[tauri::command]
pub fn check_local_setup() -> Result<String, String> {
    let env_dir = local_env_dir();
    let marker = setup_marker_path(&env_dir);
    let python = venv_python_path(&env_dir);
    let setup_running = is_local_setup_running_inner();

    if marker.exists() && python.exists() {
        let content = std::fs::read_to_string(&marker).unwrap_or_else(|_| "{}".to_string());
        let details: serde_json::Value =
            serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));
        Ok(serde_json::json!({
            "ready": true,
            "python": python.to_string_lossy().to_string(),
            "setup_running": setup_running,
            "details": details,
        })
        .to_string())
    } else {
        Ok(serde_json::json!({
            "ready": false,
            "setup_running": setup_running,
        })
        .to_string())
    }
}

fn is_local_setup_running_inner() -> bool {
    if let Ok(guard) = LOCAL_SETUP_RUNNING.lock() {
        if *guard {
            return true;
        }
    }

    #[cfg(target_os = "windows")]
    {
        let script_name = setup_script_name();
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -and $_.CommandLine -like '*{}*' }} | Select-Object -First 1 ProcessId | ConvertTo-Json -Compress",
                    script_name.replace('\\', "\\\\")
                ),
            ])
            .output();
        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() && text != "null" && text != "[]" {
                return true;
            }
        }
    }

    false
}

#[tauri::command]
pub fn is_local_setup_running() -> Result<bool, String> {
    Ok(is_local_setup_running_inner())
}

#[tauri::command]
pub fn detect_local_python() -> Result<String, String> {
    Ok(python_candidates_report())
}

#[tauri::command]
pub fn detect_local_env_in_use() -> Result<String, String> {
    Ok(detect_local_env_lock_report())
}

#[tauri::command]
pub fn kill_blocking_local_processes() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let pids = local_env_lock_processes();
        for pid in &pids {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        return Ok(format!(
            r#"{{"killed":{},"pids":{}}}"#,
            !pids.is_empty(),
            serde_json::to_string(&pids).unwrap_or_else(|_| "[]".to_string())
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(r#"{"killed":false,"pids":[]}"#.to_string())
    }
}

/// Run local setup for Faster-Whisper Realtime
#[tauri::command]
pub fn run_local_setup(
    channel: Channel<String>,
    local_model: Option<String>,
    translation_model: Option<String>,
) -> Result<(), String> {
    {
        let mut guard = LOCAL_SETUP_RUNNING.lock().map_err(|e| e.to_string())?;
        if *guard {
            return Err("Faster-Whisper Realtime setup is already running".to_string());
        }
        if is_local_setup_running_inner() {
            *guard = true;
            return Err("Faster-Whisper Realtime setup is already running".to_string());
        }
        *guard = true;
    }

    log_to_file(&format!(
        "run_local_setup called for backend={}",
        local_backend_kind()
    ));

    let script_path = match resolve_script(setup_script_name()) {
        Ok(path) => path,
        Err(err) => {
            if let Ok(mut guard) = LOCAL_SETUP_RUNNING.lock() {
                *guard = false;
            }
            return Err(err);
        }
    };
    let (python, python_args) = system_python_command();
    let local_model = local_model.unwrap_or_else(|| "turbo".to_string());
    let translation_model = translation_model.unwrap_or_else(|| "nllb_600m".to_string());

    let mut cmd = Command::new(&python);
    cmd.args(&python_args)
        .arg(&script_path)
        .arg("--model")
        .arg(&local_model)
        .arg("--translation-model")
        .arg(&translation_model)
        .env("MY_TRANSLATOR_ENV_DIR", local_env_dir().to_string_lossy().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if !cfg!(target_os = "windows") {
        cmd.env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            if let Ok(mut guard) = LOCAL_SETUP_RUNNING.lock() {
                *guard = false;
            }
            return Err(format!("Failed to start local setup with {}: {}", python, e));
        }
    };

    log_to_file(&format!("Setup process spawned, PID={}", child.id()));

    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let channel_clone = channel.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) if !line.is_empty() => {
                    log_to_file(&format!("setup stdout: {}", &line));
                    let _ = channel_clone.send(line);
                }
                Err(e) => {
                    log_to_file(&format!("setup stdout error: {}", e));
                    break;
                }
                _ => {}
            }
        }
    });

    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;
    let channel_clone2 = channel.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    log_to_file(&format!("setup stderr: {}", line));
                    let escaped = line.replace('"', r#"\""#);
                    let _ = channel_clone2.send(format!(
                        r#"{{"type":"log","message":"{}"}}"#,
                        escaped
                    ));
                }
                Err(_) => break,
            }
        }
    });

    std::thread::spawn(move || {
        let _ = child.wait();
        if let Ok(mut guard) = LOCAL_SETUP_RUNNING.lock() {
            *guard = false;
        }
    });

    Ok(())
}
