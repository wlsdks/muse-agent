use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunnerRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    timeout_ms: Option<u64>,
    max_output_bytes: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerResponse {
    ok: bool,
    status: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    truncated: bool,
    error: Option<String>,
}

fn main() {
    let response = match read_request() {
        Ok(request) => run_request(request),
        Err(error) => RunnerResponse {
            ok: false,
            status: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            truncated: false,
            error: Some(error),
        },
    };

    let mut stdout = io::stdout();
    serde_json::to_writer(&mut stdout, &response).expect("runner response should serialize");
    stdout.write_all(b"\n").expect("runner response newline should write");
}

fn read_request() -> Result<RunnerRequest, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read stdin: {error}"))?;

    serde_json::from_str(&input).map_err(|error| format!("invalid runner request JSON: {error}"))
}

fn run_request(request: RunnerRequest) -> RunnerResponse {
    if request.command.trim().is_empty() {
        return error_response("command must not be blank");
    }

    if request.command.contains('/') || request.command.contains('\\') {
        return error_response("command must be an executable name, not a path");
    }

    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1));
    let max_output_bytes = request.max_output_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES).max(1);
    let mut command = Command::new(&request.command);
    command
        .args(&request.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(cwd) = request.cwd.as_deref() {
        command.current_dir(cwd);
    }

    command.env_clear();
    command.env("PATH", env::var("PATH").unwrap_or_default());

    for (key, value) in request.env {
        if is_safe_env_key(&key) {
            command.env(key, value);
        }
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return error_response(&format!("failed to spawn command: {error}")),
    };

    // Drain stdout/stderr on dedicated threads so the child can never block
    // writing to a full OS pipe buffer (~64 KB). Without this, any command
    // that emits more than the pipe buffer before exiting deadlocks: it
    // blocks on write, never exits, and is falsely reported as `timedOut`
    // and killed. Each drainer keeps at most `max_output_bytes` and keeps
    // reading-and-discarding past the cap, so memory stays bounded AND the
    // pipe never fills.
    let stdout_drainer = spawn_drainer(child.stdout.take(), max_output_bytes);
    let stderr_drainer = spawn_drainer(child.stderr.take(), max_output_bytes);

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                timed_out = true;
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_drainer.join();
                let _ = stderr_drainer.join();
                return error_response(&format!("failed while waiting for command: {error}"));
            }
        }
    };

    // Reap the (possibly killed) child so its pipe write-ends close and the
    // drainer threads see EOF and finish.
    let _ = child.wait();
    let (stdout, stdout_truncated) = stdout_drainer.join().unwrap_or_else(|_| (String::new(), false));
    let (stderr, stderr_truncated) = stderr_drainer.join().unwrap_or_else(|_| (String::new(), false));

    RunnerResponse {
        ok: status.map(|status| status.success()).unwrap_or(false) && !timed_out,
        status: status.and_then(|status| status.code()),
        stdout,
        stderr,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
        error: None,
    }
}

/// Read a child pipe to EOF on its own thread, retaining at most
/// `max_output_bytes` and discarding the rest (while still draining so the
/// child never blocks on a full pipe). Returns the kept text and whether
/// anything was dropped.
fn spawn_drainer<R: Read + Send + 'static>(
    pipe: Option<R>,
    max_output_bytes: usize,
) -> thread::JoinHandle<(String, bool)> {
    thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut truncated = false;
        if let Some(mut pipe) = pipe {
            let mut buffer = [0u8; 8192];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        truncated = append_capped(&mut kept, &buffer[..read], max_output_bytes) || truncated;
                    }
                    Err(_) => break,
                }
            }
        }
        (String::from_utf8_lossy(&kept).into_owned(), truncated)
    })
}

/// Append `chunk` to `kept` up to `max_output_bytes`. Returns `true` if any
/// bytes were dropped (kept was already at/over the cap, or the chunk
/// overflowed it).
fn append_capped(kept: &mut Vec<u8>, chunk: &[u8], max_output_bytes: usize) -> bool {
    if kept.len() >= max_output_bytes {
        return !chunk.is_empty();
    }
    let room = max_output_bytes - kept.len();
    if chunk.len() <= room {
        kept.extend_from_slice(chunk);
        false
    } else {
        kept.extend_from_slice(&chunk[..room]);
        true
    }
}

fn is_safe_env_key(key: &str) -> bool {
    // Dynamic-loader vars (LD_PRELOAD / LD_LIBRARY_PATH / LD_AUDIT, and macOS
    // DYLD_INSERT_LIBRARIES / DYLD_*_PATH) load arbitrary code INTO the spawned
    // process — they would escape the no-shell `Command::new` + path-reject guard.
    // A model-run command never legitimately needs them, so reject the prefixes.
    !key.is_empty()
        && !key.starts_with("LD_")
        && !key.starts_with("DYLD_")
        && key
            .bytes()
            .all(|byte| byte == b'_' || byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn error_response(message: &str) -> RunnerResponse {
    RunnerResponse {
        ok: false,
        status: None,
        stdout: String::new(),
        stderr: String::new(),
        timed_out: false,
        truncated: false,
        error: Some(message.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_blank_commands() {
        let response = run_request(RunnerRequest {
            command: " ".to_string(),
            args: vec![],
            cwd: None,
            env: BTreeMap::new(),
            timeout_ms: None,
            max_output_bytes: None,
        });

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("command must not be blank"));
    }

    #[test]
    fn rejects_path_commands_to_avoid_shell_like_execution() {
        let response = run_request(RunnerRequest {
            command: "/bin/echo".to_string(),
            args: vec!["hello".to_string()],
            cwd: None,
            env: BTreeMap::new(),
            timeout_ms: None,
            max_output_bytes: None,
        });

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("command must be an executable name, not a path")
        );
    }

    #[test]
    fn append_capped_keeps_up_to_the_limit_and_flags_overflow() {
        let mut kept = Vec::new();
        assert!(!append_capped(&mut kept, b"abc", 3));
        assert_eq!(kept, b"abc");
        // already at cap: any further bytes are dropped
        assert!(append_capped(&mut kept, b"d", 3));
        assert_eq!(kept, b"abc");

        let mut partial = Vec::new();
        assert!(append_capped(&mut partial, b"abcdef", 3));
        assert_eq!(partial, b"abc");
    }

    #[test]
    fn large_output_does_not_deadlock_or_falsely_time_out() {
        // The child writes ~200 KB — far past the OS pipe buffer — then exits.
        // With concurrent pipe draining this completes near-instantly; the
        // pre-fix poll-only loop blocked until the timeout and reported a
        // false `timed_out`. A generous 10s timeout proves we don't rely on it.
        let response = run_request(RunnerRequest {
            command: "bash".to_string(),
            args: vec!["-c".to_string(), "head -c 200000 /dev/zero | tr '\\0' a".to_string()],
            cwd: None,
            env: BTreeMap::new(),
            timeout_ms: Some(10_000),
            max_output_bytes: Some(1_000_000),
        });

        assert!(!response.timed_out, "large output must not be killed as a timeout");
        assert!(response.ok, "a command that exits 0 must report ok");
        assert_eq!(response.stdout.len(), 200_000);
        assert!(!response.truncated);
    }

    #[test]
    fn caps_output_without_blocking_when_it_exceeds_max_bytes() {
        let response = run_request(RunnerRequest {
            command: "bash".to_string(),
            args: vec!["-c".to_string(), "head -c 200000 /dev/zero | tr '\\0' a".to_string()],
            cwd: None,
            env: BTreeMap::new(),
            timeout_ms: Some(10_000),
            max_output_bytes: Some(1024),
        });

        assert!(!response.timed_out);
        assert!(response.ok);
        assert_eq!(response.stdout.len(), 1024, "output is capped at max_output_bytes");
        assert!(response.truncated);
    }

    #[test]
    fn filters_environment_keys() {
        assert!(is_safe_env_key("MUSE_RUNNER"));
        assert!(is_safe_env_key("KEY_1"));
        assert!(!is_safe_env_key("Path"));
        assert!(!is_safe_env_key("BAD-NAME"));
    }

    #[test]
    fn rejects_dynamic_loader_env_keys_to_block_code_injection() {
        // Valid uppercase-identifier keys, but they hijack process launch.
        assert!(!is_safe_env_key("LD_PRELOAD"));
        assert!(!is_safe_env_key("LD_LIBRARY_PATH"));
        assert!(!is_safe_env_key("LD_AUDIT"));
        assert!(!is_safe_env_key("DYLD_INSERT_LIBRARIES"));
        assert!(!is_safe_env_key("DYLD_LIBRARY_PATH"));
        // A normal var that merely starts with the letters is still fine.
        assert!(is_safe_env_key("LDFLAGS"));
        assert!(is_safe_env_key("LOAD_PATH"));
    }
}

