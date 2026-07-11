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
        // Append an in-band marker to a stream that was cut. The `truncated` bool
        // alone is easily missed by the local model — which then reads a CUT log
        // as the whole thing and concludes wrongly ("tests passed" off a partial
        // run). The marker is self-labelled (`[muse: …]`) so it can't be confused
        // with program output, and the bool stays for programmatic consumers.
        stdout: mark_if_truncated(stdout, stdout_truncated),
        stderr: mark_if_truncated(stderr, stderr_truncated),
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
        error: if timed_out { Some(describe_timeout(timeout.as_millis())) } else { None },
    }
}

/// Self-labelled marker appended to a captured stream that was truncated at the
/// capture limit, so the model SEES in the text that output is partial.
const OUTPUT_TRUNCATION_MARKER: &str =
    "\n[muse: output truncated at the capture limit — re-run a narrower command or raise max_output_bytes to see the rest]";

fn mark_if_truncated(mut text: String, truncated: bool) -> String {
    if truncated {
        text.push_str(OUTPUT_TRUNCATION_MARKER);
    }
    text
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
        // A byte-boundary cut can split a trailing multi-byte UTF-8 char, which
        // `from_utf8_lossy` would then turn into a U+FFFD replacement char — the
        // model reads that as corruption in a verify log. Drop the partial tail
        // so truncated output stays clean valid UTF-8.
        if truncated {
            trim_partial_utf8_tail(&mut kept);
        }
        (String::from_utf8_lossy(&kept).into_owned(), truncated)
    })
}

/// Drop a trailing partial multi-byte UTF-8 char (left by a byte-boundary cut)
/// so the kept bytes are valid UTF-8. Bounded: a partial char is at most 3
/// trailing bytes, so this pops at most 3 times.
fn trim_partial_utf8_tail(bytes: &mut Vec<u8>) {
    // A partial trailing char is at most 3 bytes, so try at most 3 pops. Bounding
    // it means a buffer with INTERIOR invalid bytes (a binary blob) is never
    // over-trimmed — only a genuine byte-boundary cut of the last char is fixed;
    // anything else falls through to from_utf8_lossy unchanged.
    for _ in 0..3 {
        if std::str::from_utf8(bytes).is_ok() {
            return;
        }
        bytes.pop();
    }
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

// --- macOS seatbelt sandbox profile (SBPL) generation ---
//
// D2-S1a builds ONLY the pure profile-string generator; wiring it into
// `run_request`'s spawn path (via `sandbox-exec -p`) is sub-step D2-S1b, so
// nothing below is called yet. `#[allow(dead_code)]` on each item is the
// narrowest suppression for that gap rather than disabling the lint repo-wide.

// Confirmed by prior investigation: the caches a normal build/test/tool
// command legitimately writes into, relative to `$HOME`.
const RW_CACHE_HOME_SUBPATHS: &[&str] = &["Library/pnpm/store", ".npm", ".cache"];

#[allow(dead_code)] // wired into run_request in sub-step D2-S1b
#[derive(Debug, Clone, Copy)]
struct SeatbeltSpec<'a> {
    cwd: Option<&'a str>,
    tmpdir: &'a str,
    home: Option<&'a str>,
    allow_network: bool,
}

// SBPL double-quoted strings are a security boundary: an unescaped `"` in a
// cwd/tmpdir/home path could close the string early and splice attacker-
// controlled SBPL into the profile. Escape backslash and quote, and strip
// control characters (a raw newline would otherwise break a rule onto its
// own malformed line, which is just as dangerous as an unescaped quote).
#[allow(dead_code)] // wired into run_request in sub-step D2-S1b
fn escape_sbpl_string(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            c if c.is_control() => {}
            c => escaped.push(c),
        }
    }
    escaped
}

#[allow(dead_code)] // wired into run_request in sub-step D2-S1b
fn build_seatbelt_profile(spec: &SeatbeltSpec) -> String {
    let mut profile = String::new();
    profile.push_str("(version 1)\n");
    profile.push_str("(deny default)\n\n");

    // Minimal process-launch allowances a spawned program needs to actually
    // run under the sandbox at all — without these the child can't fork,
    // exec, signal itself, or look up its own mach services, so it would
    // fail before doing anything the sandbox is meant to gate.
    profile.push_str("(allow process-fork)\n");
    profile.push_str("(allow process-exec*)\n");
    profile.push_str("(allow signal (target self))\n");
    profile.push_str("(allow sysctl-read)\n");
    profile.push_str("(allow mach-lookup)\n\n");

    // Reading the filesystem is not the threat this sandbox gates — destructive
    // writes and network exfiltration are. So reads stay broadly allowed and
    // only writes/network get the deny-by-default treatment below.
    profile.push_str("(allow file-read*)\n\n");

    if let Some(cwd) = spec.cwd {
        profile.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escape_sbpl_string(cwd)));
    }
    profile.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escape_sbpl_string(spec.tmpdir)));

    if let Some(home) = spec.home {
        let home = home.trim_end_matches('/');
        for suffix in RW_CACHE_HOME_SUBPATHS {
            let path = format!("{home}/{suffix}");
            profile.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escape_sbpl_string(&path)));
        }
    }
    // `home: None` omits the cache rules entirely rather than emitting a
    // literal "~" — SBPL does not expand tildes, so a literal one would just
    // be a dead, wrong rule.

    if spec.allow_network {
        profile.push('\n');
        profile.push_str("(allow network*)\n");
    }
    // allow_network == false: no explicit network rule — `(deny default)`
    // above already denies it, and adding a redundant `(deny network*)` would
    // just be noise.

    profile
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_a_split_multibyte_char_so_truncated_output_has_no_replacement_char() {
        // "한" is 3 bytes (EA B0 9C). A byte cap landing after 2 of them leaves a
        // partial char; without the trim, from_utf8_lossy yields U+FFFD.
        let mut bytes = vec![b'o', b'k', 0xEA, 0xB0];
        trim_partial_utf8_tail(&mut bytes);
        assert_eq!(bytes, vec![b'o', b'k']);
        assert!(!String::from_utf8_lossy(&bytes).contains('\u{FFFD}'));
    }

    #[test]
    fn keeps_a_complete_multibyte_tail_intact() {
        let mut bytes = "ab한".as_bytes().to_vec();
        trim_partial_utf8_tail(&mut bytes);
        assert_eq!(String::from_utf8(bytes).unwrap(), "ab한");
    }

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
        // stdout is the capped 1024 bytes of program output PLUS the self-labelled
        // in-band truncation marker (the capped content itself is unchanged).
        assert!(response.stdout.starts_with(&"a".repeat(1024)), "the capped program output is preserved");
        assert!(response.stdout.contains("[muse: output truncated"), "a truncated stream carries the in-band marker");
        assert_eq!(response.stdout.len(), 1024 + OUTPUT_TRUNCATION_MARKER.len());
        assert!(response.truncated);
    }

    #[test]
    fn marks_only_a_truncated_stream() {
        assert_eq!(mark_if_truncated("ok".to_string(), false), "ok");
        let marked = mark_if_truncated("ok".to_string(), true);
        assert!(marked.starts_with("ok"));
        assert!(marked.contains("[muse: output truncated"));
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

    #[test]
    fn seatbelt_profile_has_the_version_header_and_denies_by_default() {
        let spec = SeatbeltSpec { cwd: None, tmpdir: "/tmp", home: None, allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        assert!(profile.starts_with("(version 1)\n"), "version header must lead the profile: {profile}");
        assert!(profile.contains("(deny default)"), "profile must deny by default: {profile}");
    }

    #[test]
    fn seatbelt_profile_allows_file_reads_broadly() {
        let spec = SeatbeltSpec { cwd: None, tmpdir: "/tmp", home: None, allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        assert!(profile.contains("(allow file-read*)"), "reads are not the gated threat: {profile}");
    }

    #[test]
    fn seatbelt_profile_allows_write_under_cwd_when_present() {
        let spec = SeatbeltSpec { cwd: Some("/tmp/work"), tmpdir: "/var/tmp", home: None, allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-write* (subpath \"/tmp/work\"))"),
            "cwd must get a write rule: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_has_no_cwd_write_rule_when_cwd_absent() {
        let spec = SeatbeltSpec { cwd: None, tmpdir: "/var/tmp", home: None, allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        // Only the tmpdir write rule should be present — no other subpath rule.
        let write_rule_count = profile.matches("(allow file-write*").count();
        assert_eq!(write_rule_count, 1, "only the tmpdir write rule, no cwd rule: {profile}");
    }

    #[test]
    fn seatbelt_profile_always_allows_write_under_tmpdir() {
        let spec = SeatbeltSpec { cwd: None, tmpdir: "/private/var/tmp", home: None, allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-write* (subpath \"/private/var/tmp\"))"),
            "tmpdir must always get a write rule: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_denies_network_by_default_and_allows_when_requested() {
        let denied = build_seatbelt_profile(&SeatbeltSpec { cwd: None, tmpdir: "/tmp", home: None, allow_network: false });
        assert!(!denied.contains("(allow network*)"), "network must not be allowed by default: {denied}");

        let allowed = build_seatbelt_profile(&SeatbeltSpec { cwd: None, tmpdir: "/tmp", home: None, allow_network: true });
        assert_eq!(
            allowed.matches("(allow network*)").count(),
            1,
            "exactly one network allowance when opted in: {allowed}"
        );
    }

    #[test]
    fn seatbelt_profile_expands_home_into_absolute_cache_write_rules() {
        let spec = SeatbeltSpec { cwd: None, tmpdir: "/tmp", home: Some("/Users/x"), allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        assert!(profile.contains("(allow file-write* (subpath \"/Users/x/Library/pnpm/store\"))"), "{profile}");
        assert!(profile.contains("(allow file-write* (subpath \"/Users/x/.npm\"))"), "{profile}");
        assert!(profile.contains("(allow file-write* (subpath \"/Users/x/.cache\"))"), "{profile}");
        assert!(!profile.contains('~'), "no literal tilde — SBPL never expands it: {profile}");
    }

    #[test]
    fn seatbelt_profile_omits_cache_write_rules_when_home_is_absent() {
        let spec = SeatbeltSpec { cwd: None, tmpdir: "/tmp", home: None, allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        assert!(!profile.contains("pnpm/store"), "no pnpm cache rule without a home: {profile}");
        assert!(!profile.contains(".npm"), "no npm cache rule without a home: {profile}");
        assert!(!profile.contains(".cache"), "no generic cache rule without a home: {profile}");
        assert!(!profile.contains('~'), "no literal tilde stand-in either: {profile}");
    }

    #[test]
    fn seatbelt_profile_end_to_end_example_matches_expected_shape() {
        let spec = SeatbeltSpec {
            cwd: Some("/tmp/work"),
            tmpdir: "/var/tmp",
            home: Some("/Users/x"),
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(profile.starts_with("(version 1)\n(deny default)\n"));
        assert!(profile.contains("(allow process-exec*)"));
        assert!(profile.contains("(allow file-read*)"));
        assert!(profile.contains("(allow file-write* (subpath \"/tmp/work\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/var/tmp\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/Users/x/Library/pnpm/store\"))"));
        assert!(!profile.contains("(allow network*)"));
    }

    #[test]
    fn escape_sbpl_string_escapes_quotes_and_backslashes_so_no_unescaped_quote_survives() {
        let raw = r#"/tmp/evil"))(allow network*)(dummy "path\end"#;
        let escaped = escape_sbpl_string(raw);
        assert_eq!(
            escaped,
            r#"/tmp/evil\"))(allow network*)(dummy \"path\\end"#,
            "every quote and backslash must be escaped exactly: {escaped}"
        );
        // Splicing the escaped form into a double-quoted SBPL literal must not
        // let an unescaped `"` close the string early.
        assert!(!would_close_early(&escaped), "no unescaped quote should close the SBPL string early: {escaped}");
    }

    #[test]
    fn escape_sbpl_string_strips_control_characters() {
        let raw = "/tmp/evil\n(allow network*)\t\r";
        let escaped = escape_sbpl_string(raw);
        assert_eq!(escaped, "/tmp/evil(allow network*)", "control chars are stripped, not passed through: {escaped}");
        assert!(!escaped.contains('\n') && !escaped.contains('\t') && !escaped.contains('\r'));
    }

    // Helper for the escaping test: walks the (already-escaped) inner content
    // and confirms no `"` appears without a preceding odd number of `\`s
    // (i.e. every `"` is escaped, so none of them could close the profile's
    // enclosing string early).
    fn would_close_early(escaped_inner: &str) -> bool {
        let chars: Vec<char> = escaped_inner.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '"' {
                let mut backslashes = 0;
                let mut j = i;
                while j > 0 && chars[j - 1] == '\\' {
                    backslashes += 1;
                    j -= 1;
                }
                if backslashes % 2 == 0 {
                    return true;
                }
            }
            i += 1;
        }
        false
    }
}

