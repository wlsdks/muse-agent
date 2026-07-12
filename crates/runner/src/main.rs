use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::sync::mpsc;
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
    #[serde(default)]
    allow_network: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_warning: Option<String>,
}

/// Whether/how the child runs under the macOS seatbelt sandbox, resolved once
/// per process from `MUSE_RUNNER_SANDBOX` — never read again mid-run, so a
/// concurrent test can't race the env var.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SandboxMode {
    Disabled,
    Seatbelt,
    /// `MUSE_RUNNER_SANDBOX=seatbelt` was requested but this platform has no
    /// seatbelt support — falls back to unsandboxed with a surfaced warning
    /// rather than silently failing closed (there is nothing to sandbox WITH).
    RequestedUnsupported,
}

fn resolve_sandbox_mode() -> SandboxMode {
    let requested = env::var("MUSE_RUNNER_SANDBOX").map(|v| v == "seatbelt").unwrap_or(false);
    if !requested {
        SandboxMode::Disabled
    } else if cfg!(target_os = "macos") {
        SandboxMode::Seatbelt
    } else {
        SandboxMode::RequestedUnsupported
    }
}

fn main() {
    let mode = resolve_sandbox_mode();
    let response = match read_request() {
        Ok(request) => run_request(request, mode),
        Err(error) => RunnerResponse {
            ok: false,
            status: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            truncated: false,
            error: Some(error),
            sandbox_warning: None,
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

/// The concrete `Command::new(program).args(args)` this run will spawn, resolved
/// once from `(request, mode)` so it is a pure, directly-testable step separate
/// from the actual process spawn/wait machinery below.
#[derive(Debug, PartialEq, Eq)]
struct SpawnPlan {
    program: String,
    args: Vec<String>,
    /// Set only when running under Seatbelt — the canonicalized TMPDIR the
    /// profile allows writes under, so the child env can be pointed at it.
    tmpdir: Option<String>,
    sandbox_warning: Option<String>,
    sandbox_active: bool,
}

// Seatbelt matches CANONICAL paths — cwd/TMPDIR/HOME are frequently symlinks
// (macOS $TMPDIR → /var/folders/... → /private/var/folders/...), and an
// uncanonicalized subpath rule silently denies everything under it. So every
// path that reaches `build_seatbelt_profile` is canonicalized here first, and
// any failure to canonicalize fails the whole request closed (never a rule
// built on an unresolved, wrong path).
fn spawn_plan(request: &RunnerRequest, mode: SandboxMode) -> Result<SpawnPlan, String> {
    match mode {
        SandboxMode::Disabled => Ok(SpawnPlan {
            program: request.command.clone(),
            args: request.args.clone(),
            tmpdir: None,
            sandbox_warning: None,
            sandbox_active: false,
        }),
        SandboxMode::RequestedUnsupported => Ok(SpawnPlan {
            program: request.command.clone(),
            args: request.args.clone(),
            tmpdir: None,
            sandbox_warning: Some(
                "MUSE_RUNNER_SANDBOX=seatbelt was requested, but seatbelt sandboxing is only supported on macOS — running this command unsandboxed.".to_string(),
            ),
            sandbox_active: false,
        }),
        SandboxMode::Seatbelt => {
            let cwd_path = match request.cwd.as_deref() {
                Some(cwd) => cwd.to_string(),
                None => env::current_dir()
                    .map_err(|error| format!("failed to resolve the current directory for sandboxing: {error}"))?
                    .to_string_lossy()
                    .into_owned(),
            };
            let canonical_cwd = canonicalize_for_sandbox("cwd", &cwd_path)?;

            let raw_tmpdir = env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
            let canonical_tmpdir = canonicalize_for_sandbox("tmpdir", &raw_tmpdir)?;

            let canonical_home = match env::var("HOME") {
                Ok(home) => Some(canonicalize_for_sandbox("home", &home)?),
                Err(_) => None,
            };

            let spec = SeatbeltSpec {
                cwd: Some(canonical_cwd.as_str()),
                tmpdir: canonical_tmpdir.as_str(),
                home: canonical_home.as_deref(),
                allow_network: request.allow_network,
            };
            let profile = build_seatbelt_profile(&spec);

            let mut args = vec!["-p".to_string(), profile, request.command.clone()];
            args.extend(request.args.iter().cloned());

            Ok(SpawnPlan {
                program: "/usr/bin/sandbox-exec".to_string(),
                args,
                tmpdir: Some(canonical_tmpdir),
                sandbox_warning: None,
                sandbox_active: true,
            })
        }
    }
}

fn canonicalize_for_sandbox(label: &str, path: &str) -> Result<String, String> {
    fs::canonicalize(path)
        .map(|canonical| canonical.to_string_lossy().into_owned())
        .map_err(|error| format!("failed to canonicalize {label} '{path}' for sandboxing: {error}"))
}

fn run_request(request: RunnerRequest, mode: SandboxMode) -> RunnerResponse {
    if request.command.trim().is_empty() {
        return error_response("command must not be blank");
    }

    if request.command.contains('/') || request.command.contains('\\') {
        return error_response("command must be an executable name, not a path");
    }

    let plan = match spawn_plan(&request, mode) {
        Ok(plan) => plan,
        Err(error) => return error_response(&error),
    };

    let timeout = Duration::from_millis(effective_timeout_ms(request.timeout_ms));
    let max_output_bytes = effective_max_output_bytes(request.max_output_bytes);
    let mut command = Command::new(&plan.program);
    command
        .args(&plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(cwd) = request.cwd.as_deref() {
        command.current_dir(cwd);
    }

    command.env_clear();
    command.env("PATH", env::var("PATH").unwrap_or_default());

    if let Some(tmpdir) = plan.tmpdir.as_deref() {
        command.env("TMPDIR", tmpdir);
    }

    for (key, value) in request.env {
        if is_safe_env_key(&key) {
            command.env(key, value);
        }
    }

    // Make the child its own process-group leader (pgid == its own pid) so the
    // whole tree it spawns can be signalled together. Without this, a
    // backgrounded grandchild (`sh -c "sleep 300 &"`) stays in the runner's OWN
    // process group, survives a kill of just the direct child as an orphan, and
    // — if it inherited the stdout/stderr pipe — keeps the write end open,
    // wedging the drainer threads' join past the direct child's own exit.
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return error_response(&describe_spawn_error(&request.command, &error)),
    };
    let pgid = child.id() as i32;

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
                kill_process_group(pgid);
                let _ = recv_drained(stdout_drainer);
                let _ = recv_drained(stderr_drainer);
                return error_response(&format!("failed while waiting for command: {error}"));
            }
        }
    };

    // Reap the (possibly killed) direct child so its own pipe write-ends close,
    // THEN sweep the whole process group. A grandchild backgrounded by the
    // child (`sh -c "sleep 300 &"`) is not reaped by `child.wait()` — it lives
    // on as an orphan in the same group whether the child exited on its own or
    // was just killed for timing out. Kill the group so nothing is left
    // running and no pipe write-end it inherited stays open.
    let _ = child.wait();
    kill_process_group(pgid);
    let (stdout, stdout_truncated) = recv_drained(stdout_drainer);
    let (stderr, stderr_truncated) = recv_drained(stderr_drainer);

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
        sandbox_warning: plan.sandbox_warning,
    }
}

// The direct child was made its own process-group leader at spawn time
// (`process_group(0)`), so its pgid equals its own pid — signalling `-pgid`
// (a negative pid means "the whole group") reaches it AND every descendant
// it spawned, including ones it never waited on. `Child::kill()` only ever
// signals the single direct-child pid, which is exactly the gap this closes.
//
// This shells out to the `kill` utility rather than adding a `libc` dependency
// for a raw `kill(2)` call — the crate already shells out to a system binary
// for sandboxing (`/usr/bin/sandbox-exec`), so this follows the same pattern
// without growing the dependency graph. A missing target (already exited) is
// not an error worth surfacing — this is best-effort cleanup, always run
// after the direct child has already been reaped.
#[cfg(unix)]
fn kill_process_group(pgid: i32) {
    let _ = Command::new("kill")
        .arg("-KILL")
        .arg(format!("-{pgid}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn kill_process_group(_pgid: i32) {}

/// A drainer thread should finish almost instantly once `kill_process_group`
/// has run — every writer of the pipe is dead, so `read` hits EOF. Bound the
/// wait anyway: if some writer somehow survives group-kill, the runner must
/// still return (with whatever was captured so far) rather than wedge past
/// its own configured timeout.
const DRAIN_RECV_TIMEOUT: Duration = Duration::from_secs(2);

fn recv_drained(drainer: mpsc::Receiver<(String, bool)>) -> (String, bool) {
    drainer.recv_timeout(DRAIN_RECV_TIMEOUT).unwrap_or_else(|_| (String::new(), false))
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
/// child never blocks on a full pipe). Sends the kept text and whether
/// anything was dropped over the returned channel — a channel (rather than a
/// bare `JoinHandle`) lets the receiver bound its wait with `recv_timeout`
/// instead of blocking forever on `.join()` (see `recv_drained`).
fn spawn_drainer<R: Read + Send + 'static>(
    pipe: Option<R>,
    max_output_bytes: usize,
) -> mpsc::Receiver<(String, bool)> {
    let (sender, receiver) = mpsc::channel();
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
        let _ = sender.send((String::from_utf8_lossy(&kept).into_owned(), truncated));
    });
    receiver
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
    "NODE_OPTIONS", "NODE_PATH",
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
    "PERL5OPT", "PERL5DB", "PERLLIB", "PERL5LIB",
    "PYTHONSTARTUP", "PYTHONPATH", "PYTHONINSPECT", "PYTHONHOME",
    "RUBYOPT", "RUBYLIB", "GEM_HOME", "GEM_PATH",
    // JVM honors -javaagent via *_JAVA_OPTIONS on startup; CLASSPATH/LESSOPEN same class.
    "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "LESSOPEN",
    // PATH is the ONLY resolution path for a bare command name (a `/` is rejected),
    // so a model-set PATH redirects a guard-passing name to an attacker binary.
    // Strip it; the runner-set PATH (above) resolves normal commands.
    "PATH",
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
        sandbox_warning: None,
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
// Used by `spawn_plan` when `MUSE_RUNNER_SANDBOX=seatbelt` resolves to
// `SandboxMode::Seatbelt` (macOS only).

// Confirmed by prior investigation: the caches a normal build/test/tool
// command legitimately writes into, relative to `$HOME`.
const RW_CACHE_HOME_SUBPATHS: &[&str] = &["Library/pnpm/store", ".npm", ".cache"];

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

    // Without this, even `sh -c 'echo x > /dev/null'` and ALL of git fail
    // ("could not open /dev/null") — every well-behaved Unix tool routinely
    // discards output through these two devices.
    profile.push_str("(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n");

    if let Some(cwd) = spec.cwd {
        profile.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escape_sbpl_string(cwd)));
    }
    profile.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escape_sbpl_string(spec.tmpdir)));
    // Some tools hardcode `/tmp` rather than reading `$TMPDIR` — on macOS that
    // is itself a symlink to `/private/tmp`, so allow it explicitly alongside
    // the canonicalized `spec.tmpdir` rather than relying on the two coinciding.
    profile.push_str("(allow file-write* (subpath \"/private/tmp\"))\n");

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
            allow_network: false,
        }, SandboxMode::Disabled);

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("command must not be blank"));
    }

    #[test]
    fn strips_path_and_code_injection_env_vars() {
        // PATH would redirect a bare command name (a `/` is rejected) to an
        // attacker binary, bypassing the command guard; *_JAVA_OPTIONS / PYTHONHOME
        // / loader vars are the same interpreter-startup code-exec class.
        for key in [
            "PATH", "NODE_OPTIONS", "NODE_PATH", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS",
            "JDK_JAVA_OPTIONS", "PYTHONHOME", "CLASSPATH", "LESSOPEN", "GEM_HOME",
            "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "GIT_SSH_COMMAND",
        ] {
            assert!(!is_safe_env_key(key), "{key} must be rejected");
        }
        assert!(is_safe_env_key("MUSE_OK"));
        assert!(is_safe_env_key("TERM"));
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
            allow_network: false,
        }, SandboxMode::Disabled);

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
            allow_network: false,
        }, SandboxMode::Disabled);

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
            allow_network: false,
        }, SandboxMode::Disabled);

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
            allow_network: false,
        }, SandboxMode::Disabled);
        assert!(resp.timed_out, "the command was killed for timing out");
        assert!(!resp.ok, "a timed-out command is not ok");
        assert!(
            resp.error.as_deref().unwrap_or("").contains("timed out"),
            "error carries the actionable timeout message, not None: {:?}",
            resp.error
        );
    }

    #[cfg(unix)]
    #[test]
    fn backgrounded_grandchild_is_reaped_with_the_group_and_never_wedges_the_runner() {
        // The exact shape of the verified finding: the direct child backgrounds
        // a grandchild with `&` and exits right away — `sh -c "sleep N && touch
        // marker &"` returns almost instantly. The grandchild inherits the
        // stdout/stderr pipe write-ends and, pre-fix, is never reaped (only the
        // direct child is waited on) — so it survives as an orphan and keeps a
        // pipe write-end open, which wedges `stdout_drainer`/`stderr_drainer`'s
        // join past the direct child's own exit until the grandchild finishes
        // its own sleep (here, 2s later) and closes the pipe on its own.
        //
        // MUTATION-FIRST: without process-group spawn + group-kill, this test
        // fails two ways — `elapsed` is ~2s (the wedge), and the marker file
        // DOES exist after the post-sleep (the grandchild ran to completion as
        // an orphan instead of being killed with the group).
        let marker = std::env::temp_dir().join(format!(
            "muse-runner-group-kill-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let marker_path = marker.to_string_lossy().into_owned();
        let script = format!("(sleep 2 && touch {marker_path}) &\necho parent-done");

        let started = Instant::now();
        let response = run_request(RunnerRequest {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), script],
            cwd: None,
            env: BTreeMap::new(),
            timeout_ms: Some(5_000),
            max_output_bytes: None,
            allow_network: false,
        }, SandboxMode::Disabled);
        let elapsed = started.elapsed();

        assert!(response.ok, "the direct child completes normally: {response:?}");
        assert!(!response.timed_out, "the direct child exits well within the 5s timeout: {response:?}");
        assert!(
            elapsed < Duration::from_secs(1),
            "the runner must return promptly once the direct child exits, not wedge on the orphaned grandchild's pipe: {elapsed:?}"
        );

        // Give the grandchild's own 2s sleep time to have completed IF it
        // survived as an orphan — proves it was actually killed, not merely
        // that this process raced ahead of it.
        thread::sleep(Duration::from_secs(3));
        assert!(
            !marker.exists(),
            "the backgrounded grandchild must be killed together with the process group, not survive to finish its delayed write"
        );

        let _ = fs::remove_file(&marker);
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
        let other = describe_spawn_error("x", &Error::other("weird failure"));
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
        // The tmpdir rule and the always-on /private/tmp rule should be present —
        // no other subpath rule (i.e. no cwd rule).
        let write_rule_count = profile.matches("(allow file-write*").count();
        assert_eq!(write_rule_count, 2, "tmpdir + /private/tmp only, no cwd rule: {profile}");
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
    fn seatbelt_profile_allows_dev_null_and_dtracehelper_writes() {
        let spec = SeatbeltSpec { cwd: None, tmpdir: "/tmp", home: None, allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))"),
            "sh/git write to /dev/null and dtrace helper must be allowed: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_always_allows_write_under_private_tmp() {
        let spec = SeatbeltSpec { cwd: None, tmpdir: "/var/folders/x/y", home: None, allow_network: false };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-write* (subpath \"/private/tmp\"))"),
            "a tool hard-coding /tmp must not false-positive even when TMPDIR differs: {profile}"
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
        assert!(profile.contains("(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/tmp/work\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/var/tmp\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/private/tmp\"))"));
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

    fn sample_request() -> RunnerRequest {
        RunnerRequest {
            command: "node".to_string(),
            args: vec!["report.mjs".to_string()],
            cwd: Some("/tmp".to_string()),
            env: BTreeMap::new(),
            timeout_ms: None,
            max_output_bytes: None,
            allow_network: false,
        }
    }

    #[test]
    fn disabled_plan_is_an_identical_passthrough() {
        let plan = spawn_plan(&sample_request(), SandboxMode::Disabled).expect("disabled mode never fails to plan");
        assert_eq!(plan.program, "node");
        assert_eq!(plan.args, vec!["report.mjs".to_string()]);
        assert_eq!(plan.sandbox_warning, None);
        assert!(!plan.sandbox_active);
        assert_eq!(plan.tmpdir, None);
    }

    #[test]
    fn requested_unsupported_plan_is_a_passthrough_with_a_warning() {
        let plan = spawn_plan(&sample_request(), SandboxMode::RequestedUnsupported)
            .expect("unsupported-platform mode falls back, it never fails to plan");
        assert_eq!(plan.program, "node");
        assert_eq!(plan.args, vec!["report.mjs".to_string()]);
        assert!(!plan.sandbox_active, "unsupported platform never actually sandboxes");
        let warning = plan.sandbox_warning.expect("a requested-but-unsupported sandbox must surface a warning");
        assert!(warning.contains("seatbelt"), "names the requested mechanism: {warning}");
        assert!(warning.to_lowercase().contains("unsandboxed") || warning.to_lowercase().contains("without"), "says the command still ran: {warning}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_plan_wraps_the_command_in_sandbox_exec_with_a_canonicalized_cwd_rule() {
        let dir = std::env::temp_dir();
        let canonical_dir = std::fs::canonicalize(&dir).expect("temp dir must canonicalize on a real machine");
        let request = RunnerRequest {
            command: "node".to_string(),
            args: vec!["report.mjs".to_string(), "--flag".to_string()],
            cwd: Some(dir.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            timeout_ms: None,
            max_output_bytes: None,
            allow_network: false,
        };
        let plan = spawn_plan(&request, SandboxMode::Seatbelt).expect("a real temp dir must canonicalize");
        assert_eq!(plan.program, "/usr/bin/sandbox-exec");
        assert_eq!(plan.args[0], "-p");
        let profile = &plan.args[1];
        assert!(
            profile.contains(&canonical_dir.to_string_lossy().into_owned()),
            "profile must carry the canonicalized cwd: {profile}"
        );
        assert_eq!(&plan.args[2], "node");
        assert_eq!(&plan.args[3], "report.mjs");
        assert_eq!(&plan.args[4], "--flag");
        assert!(plan.sandbox_active);
        assert!(plan.sandbox_warning.is_none());
        assert!(plan.tmpdir.is_some());
    }

    #[test]
    fn seatbelt_plan_fails_closed_on_an_uncanonicalizable_cwd() {
        let request = RunnerRequest {
            command: "node".to_string(),
            args: vec![],
            cwd: Some("/this/path/definitely/does/not/exist/on/any/machine".to_string()),
            env: BTreeMap::new(),
            timeout_ms: None,
            max_output_bytes: None,
            allow_network: false,
        };
        // On non-macOS this mode never actually resolves to Seatbelt via
        // `resolve_sandbox_mode`, but `spawn_plan` itself is exercised directly
        // here regardless of platform to prove the fail-close path.
        let result = spawn_plan(&request, SandboxMode::Seatbelt);
        assert!(result.is_err(), "an unresolvable cwd must fail closed, never fall back to unsandboxed");
    }

    #[test]
    fn response_with_no_sandbox_warning_serializes_without_the_field() {
        let response = error_response("boom");
        let json = serde_json::to_string(&response).expect("response must serialize");
        assert!(!json.contains("sandboxWarning"), "an absent warning must not appear in the JSON at all: {json}");
    }

    #[test]
    fn response_with_a_sandbox_warning_serializes_it_as_camel_case() {
        let mut response = error_response("boom");
        response.sandbox_warning = Some("seatbelt unsupported here".to_string());
        let json = serde_json::to_string(&response).expect("response must serialize");
        assert!(json.contains("\"sandboxWarning\":\"seatbelt unsupported here\""), "warning must serialize camelCase: {json}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_sandbox_contract_tests {
    use super::*;
    use std::fs;
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn sandbox_exec_available() -> bool {
        Path::new("/usr/bin/sandbox-exec").exists()
    }

    fn seatbelt_request(cwd: &Path, command: &str, args: Vec<String>, allow_network: bool) -> RunnerRequest {
        RunnerRequest {
            command: command.to_string(),
            args,
            cwd: Some(cwd.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            timeout_ms: Some(10_000),
            max_output_bytes: Some(1_000_000),
            allow_network,
        }
    }

    #[test]
    fn legit_command_succeeds_under_seatbelt() {
        if !sandbox_exec_available() {
            eprintln!("skipping: /usr/bin/sandbox-exec not present on this machine");
            return;
        }
        let dir = std::env::temp_dir().join(format!("muse-runner-seatbelt-ok-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("test temp dir must be creatable");
        let marker = dir.join("marker.txt");

        let script = format!(
            "echo hello > {marker} && cat {marker} && echo tmp-ok > \"$TMPDIR/muse-runner-tmp-{pid}.txt\" && echo x > /dev/null",
            marker = marker.to_string_lossy(),
            pid = std::process::id()
        );
        let request = seatbelt_request(&dir, "sh", vec!["-c".to_string(), script], false);
        let response = run_request(request, SandboxMode::Seatbelt);

        assert!(response.ok, "a legitimate command must succeed under seatbelt: {response:?}");
        assert_eq!(response.status, Some(0));
        assert!(marker.exists(), "the cwd write must actually land on disk");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn escape_write_outside_cwd_is_blocked() {
        if !sandbox_exec_available() {
            eprintln!("skipping: /usr/bin/sandbox-exec not present on this machine");
            return;
        }
        let dir = std::env::temp_dir().join(format!("muse-runner-seatbelt-escape1-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("test temp dir must be creatable");
        let target = format!("/private/var/tmp/muse-runner-escape-{}.txt", std::process::id());

        let request = seatbelt_request(&dir, "sh", vec!["-c".to_string(), format!("echo x > {target}")], false);
        let response = run_request(request, SandboxMode::Seatbelt);

        assert!(!response.ok, "a write outside cwd/tmpdir must be denied: {response:?}");
        assert!(!Path::new(&target).exists(), "the escape write must not have landed on disk");

        let _ = fs::remove_file(&target);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn escape_write_to_home_ssh_is_blocked() {
        if !sandbox_exec_available() {
            eprintln!("skipping: /usr/bin/sandbox-exec not present on this machine");
            return;
        }
        let dir = std::env::temp_dir().join(format!("muse-runner-seatbelt-escape2-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("test temp dir must be creatable");

        let home = env::var("HOME").expect("HOME must be set to run this test");
        let ssh_dir = Path::new(&home).join(".ssh");
        let target = if ssh_dir.is_dir() {
            ssh_dir.join(format!("muse-runner-escape-{}.txt", std::process::id()))
        } else {
            Path::new(&home).join(format!("muse-runner-escape-{}.txt", std::process::id()))
        };

        let request = seatbelt_request(&dir, "sh", vec!["-c".to_string(), format!("echo x > {}", target.to_string_lossy())], false);
        let response = run_request(request, SandboxMode::Seatbelt);

        assert!(!response.ok, "a write to a home-sensitive path must be denied: {response:?}");
        assert!(!target.exists(), "the escape write must not have landed on disk");

        let _ = fs::remove_file(&target);
        let _ = fs::remove_dir_all(&dir);
    }

    fn accept_once_in_background(listener: TcpListener) -> Arc<AtomicBool> {
        let accepted = Arc::new(AtomicBool::new(false));
        let accepted_flag = Arc::clone(&accepted);
        listener.set_nonblocking(false).expect("listener must support blocking accept");
        thread::spawn(move || {
            listener.set_nonblocking(true).ok();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                if listener.accept().is_ok() {
                    accepted_flag.store(true, Ordering::SeqCst);
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        accepted
    }

    #[test]
    fn network_is_denied_by_default_and_allowed_when_opted_in() {
        if !sandbox_exec_available() {
            eprintln!("skipping: /usr/bin/sandbox-exec not present on this machine");
            return;
        }
        if !Path::new("/usr/bin/curl").exists() {
            eprintln!("skipping: /usr/bin/curl not present on this machine");
            return;
        }
        let dir = std::env::temp_dir().join(format!("muse-runner-seatbelt-net-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("test temp dir must be creatable");

        // Denied leg: no listener should ever see a connection attempt.
        let denied_listener = TcpListener::bind("127.0.0.1:0").expect("must bind a local ephemeral port");
        let denied_port = denied_listener.local_addr().expect("bound listener has a local addr").port();
        let denied_accepted = accept_once_in_background(denied_listener);
        let denied_request = seatbelt_request(
            &dir,
            "curl",
            vec!["-s".to_string(), "--max-time".to_string(), "2".to_string(), format!("http://127.0.0.1:{denied_port}/")],
            false
        );
        let denied_response = run_request(denied_request, SandboxMode::Seatbelt);
        thread::sleep(Duration::from_millis(300));
        assert!(!denied_response.ok, "curl must fail when network is denied: {denied_response:?}");
        assert!(!denied_accepted.load(Ordering::SeqCst), "the denied listener must never observe a connection");

        // Allowed leg: connection must be observed (curl's own exit code is not
        // asserted — the listener isn't real HTTP, so curl may still error on a
        // malformed response; what matters is the TCP connection itself lands).
        let allowed_listener = TcpListener::bind("127.0.0.1:0").expect("must bind a second local ephemeral port");
        let allowed_port = allowed_listener.local_addr().expect("bound listener has a local addr").port();
        let allowed_accepted = accept_once_in_background(allowed_listener);
        let allowed_request = seatbelt_request(
            &dir,
            "curl",
            vec!["-s".to_string(), "--max-time".to_string(), "2".to_string(), format!("http://127.0.0.1:{allowed_port}/")],
            true
        );
        let _allowed_response = run_request(allowed_request, SandboxMode::Seatbelt);
        thread::sleep(Duration::from_millis(300));
        assert!(allowed_accepted.load(Ordering::SeqCst), "an opted-in request must be observed connecting");

        let _ = fs::remove_dir_all(&dir);
    }
}

