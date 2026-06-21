use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 64 * 1024;
// Upper bounds on the model-controlled resource knobs — a huge `timeout_ms`
// would hang the runner for days; a huge `max_output_bytes` would buffer
// unbounded output into memory. Clamp to a generous-but-finite ceiling
// (the TS parser clamps to the same; this is the authoritative defence).
const MAX_TIMEOUT_MS: u64 = 600_000;
const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;

fn effective_timeout_ms(requested: Option<u64>) -> u64 {
    requested.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS)
}

fn effective_max_output_bytes(requested: Option<usize>) -> usize {
    requested.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES).clamp(1, MAX_OUTPUT_BYTES)
}

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

    let timeout = Duration::from_millis(effective_timeout_ms(request.timeout_ms));
    let max_output_bytes = effective_max_output_bytes(request.max_output_bytes);
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
        Err(error) => return error_response(&describe_spawn_error(&request.command, &error)),
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
        error: if timed_out { Some(describe_timeout(timeout.as_millis())) } else { None },
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

// Env vars that load/run arbitrary CODE at launch — they escape the no-shell
// `Command::new` + path-reject guard (which only constrain WHICH binary runs).
// Beyond the dynamic loader (LD_*/DYLD_* prefixes), each runtime has its own:
// NODE_OPTIONS (--require), shell startup (BASH_ENV/ENV), interpreter opt/path
// injection (perl/python/ruby), and git's command-exec hooks.
const UNSAFE_ENV_EXACT: &[&str] = &[
    "NODE_OPTIONS",
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
    "PERL5OPT", "PERL5DB", "PERLLIB", "PERL5LIB",
    "PYTHONSTARTUP", "PYTHONPATH", "PYTHONINSPECT",
    "RUBYOPT", "RUBYLIB",
    "GIT_SSH_COMMAND", "GIT_SSH", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_PROXY_COMMAND", "GIT_ASKPASS",
    // GIT_CONFIG* point git at an attacker config (core.sshCommand / core.pager)
    // — a second path to the command-exec hooks above.
    "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
];

fn is_safe_env_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with("LD_")
        && !key.starts_with("DYLD_")
        && !UNSAFE_ENV_EXACT.contains(&key)
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

// A raw "No such file or directory (os error 2)" from a failed spawn dead-ends
// the local model — it can't tell a typo'd command from an uninstalled tool.
// Map the two common kinds to an actionable message naming the command.
fn describe_spawn_error(command: &str, error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            format!("command '{command}' not found — it is not installed or not on PATH; check the name.")
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("command '{command}' is not executable (permission denied).")
        }
        _ => format!("failed to spawn command: {error}"),
    }
}

// A bare `timedOut: true` flag is easy for the local model to miss; pair it with
// an actionable error message (the same shape as the spawn-failure message) so
// the model knows the command was KILLED for running too long and how to react.
fn describe_timeout(timeout_ms: u128) -> String {
    format!("command timed out after {timeout_ms}ms and was killed — it may be hanging; retry with a larger timeoutMs or a more targeted command.")
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

    #[test]
    fn rejects_the_whole_code_injection_env_family() {
        for key in ["NODE_OPTIONS", "BASH_ENV", "ENV", "SHELLOPTS", "PERL5OPT", "PYTHONSTARTUP", "PYTHONPATH", "RUBYOPT", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_PROXY_COMMAND", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] {
            assert!(!is_safe_env_key(key), "{key} must be rejected");
        }
        // Legitimate, similarly-named vars survive.
        for key in ["NODE_ENV", "GIT_DIR", "GIT_AUTHOR_NAME", "MY_FLAG"] {
            assert!(is_safe_env_key(key), "{key} must be allowed");
        }
    }

    #[test]
    fn timeout_message_is_actionable() {
        let msg = describe_timeout(5000);
        assert!(msg.contains("5000ms"), "names the elapsed timeout: {msg}");
        assert!(msg.contains("timed out") && msg.contains("killed"), "explains the kill: {msg}");
        assert!(msg.contains("timeoutMs"), "tells the model how to react: {msg}");
        // A timeout means the command needed MORE time than the budget — so the
        // remediation must advise a LARGER timeout, never a smaller one (a smaller
        // budget kills the retry sooner). Pin the DIRECTION, not just the token
        // (JUDGE-DRILL #4: "smaller timeoutMs" passed a contains-only check).
        assert!(msg.contains("larger"), "advises MORE time on a timeout: {msg}");
        assert!(!msg.contains("smaller"), "never advises a smaller timeout — it would kill the retry sooner: {msg}");
        assert!(!msg.contains("os error"), "no raw errno: {msg}");
    }

    #[cfg(unix)]
    #[test]
    fn run_request_surfaces_the_timeout_message_end_to_end() {
        // a real command that outlives a tiny timeout → killed → the model must
        // receive BOTH timed_out=true AND the actionable error message (not None).
        let resp = run_request(RunnerRequest {
            command: "sleep".to_string(),
            args: vec!["5".to_string()],
            cwd: None,
            env: std::collections::BTreeMap::new(),
            timeout_ms: Some(50),
            max_output_bytes: None,
        });
        assert!(resp.timed_out, "the command was killed for timing out");
        assert!(!resp.ok, "a timed-out command is not ok");
        assert!(
            resp.error.as_deref().unwrap_or("").contains("timed out"),
            "error carries the actionable timeout message, not None: {:?}",
            resp.error
        );
    }

    #[test]
    fn spawn_error_maps_to_actionable_message() {
        use std::io::{Error, ErrorKind};
        // command-not-found → names the command, no raw "os error", actionable.
        let nf = describe_spawn_error("pytest", &Error::new(ErrorKind::NotFound, "No such file or directory (os error 2)"));
        assert!(nf.contains("pytest"), "names the command: {nf}");
        assert!(nf.contains("not found") && nf.contains("PATH"), "actionable: {nf}");
        assert!(!nf.contains("os error"), "no raw errno: {nf}");
        // sibling: not-executable
        let pd = describe_spawn_error("script.sh", &Error::new(ErrorKind::PermissionDenied, "denied"));
        assert!(pd.contains("script.sh") && pd.contains("not executable"), "perm: {pd}");
        // anything else falls through to the generic message (unchanged).
        let other = describe_spawn_error("x", &Error::new(ErrorKind::Other, "weird failure"));
        assert!(other.contains("failed to spawn command") && other.contains("weird failure"), "generic: {other}");
    }

    #[test]
    fn clamps_resource_knobs_to_sane_bounds() {
        // Huge values clamp to the ceiling; sane values pass; absent → default.
        assert_eq!(effective_timeout_ms(Some(999_999_999)), MAX_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(Some(5_000)), 5_000);
        assert_eq!(effective_timeout_ms(Some(0)), 1);
        assert_eq!(effective_timeout_ms(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(effective_max_output_bytes(Some(5_000_000_000)), MAX_OUTPUT_BYTES);
        assert_eq!(effective_max_output_bytes(Some(1024)), 1024);
        assert_eq!(effective_max_output_bytes(None), DEFAULT_MAX_OUTPUT_BYTES);
    }
}

