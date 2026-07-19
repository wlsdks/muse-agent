use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
// The runner reads one JSON request from an untrusted parent process. Bound it
// before JSON parsing so a malformed multi-gigabyte stdin payload cannot make
// the runner allocate unbounded memory.
const MAX_REQUEST_BYTES: usize = 1 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MAX_RUNTIME_DEPENDENCIES: usize = 256;

fn effective_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS)
}

fn effective_max_output_bytes(requested: Option<usize>) -> usize {
    requested
        .unwrap_or(DEFAULT_MAX_OUTPUT_BYTES)
        .clamp(1, MAX_OUTPUT_BYTES)
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
    /// Trusted caller-only strict filesystem boundary. Model-facing parsers do
    /// not expose this field.
    isolation_root: Option<String>,
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
    let requested = env::var("MUSE_RUNNER_SANDBOX")
        .map(|v| v == "seatbelt")
        .unwrap_or(false);
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
    stdout
        .write_all(b"\n")
        .expect("runner response newline should write");
}

fn read_request() -> Result<RunnerRequest, String> {
    read_request_from(io::stdin())
}

fn read_request_from<R: Read>(input: R) -> Result<RunnerRequest, String> {
    let mut bytes = Vec::with_capacity(MAX_REQUEST_BYTES + 1);
    input
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read stdin: {error}"))?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(format!(
            "runner request exceeds the {MAX_REQUEST_BYTES} byte limit"
        ));
    }

    serde_json::from_slice(&bytes).map_err(|error| format!("invalid runner request JSON: {error}"))
}

/// The concrete `Command::new(program).args(args)` this run will spawn, resolved
/// once from `(request, mode)` so it is a pure, directly-testable step separate
/// from the actual process spawn/wait machinery below.
#[derive(Debug, PartialEq, Eq)]
struct SpawnPlan {
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    /// Set only when running under Seatbelt — the canonicalized TMPDIR the
    /// profile allows writes under, so the child env can be pointed at it.
    tmpdir: Option<String>,
    sandbox_warning: Option<String>,
    sandbox_active: bool,
    strict_root: Option<String>,
}

// Seatbelt matches CANONICAL paths — cwd/TMPDIR/HOME are frequently symlinks
// (macOS $TMPDIR → /var/folders/... → /private/var/folders/...), and an
// uncanonicalized subpath rule silently denies everything under it. So every
// path that reaches `build_seatbelt_profile` is canonicalized here first, and
// any failure to canonicalize fails the whole request closed (never a rule
// built on an unresolved, wrong path).
fn spawn_plan(request: &RunnerRequest, mode: SandboxMode) -> Result<SpawnPlan, String> {
    if request.isolation_root.is_some() {
        return strict_isolation_spawn_plan(request);
    }
    match mode {
        SandboxMode::Disabled => Ok(SpawnPlan {
            program: request.command.clone(),
            args: request.args.clone(),
            cwd: request.cwd.clone(),
            tmpdir: None,
            sandbox_warning: None,
            sandbox_active: false,
            strict_root: None,
        }),
        SandboxMode::RequestedUnsupported => Ok(SpawnPlan {
            program: request.command.clone(),
            args: request.args.clone(),
            cwd: request.cwd.clone(),
            tmpdir: None,
            sandbox_warning: Some(
                "MUSE_RUNNER_SANDBOX=seatbelt was requested, but seatbelt sandboxing is only supported on macOS — running this command unsandboxed.".to_string(),
            ),
            sandbox_active: false,
            strict_root: None,
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
                cwd: Some(canonical_cwd),
                tmpdir: Some(canonical_tmpdir),
                sandbox_warning: None,
                sandbox_active: true,
                strict_root: None,
            })
        }
    }
}

fn strict_isolation_spawn_plan(request: &RunnerRequest) -> Result<SpawnPlan, String> {
    let raw_root = request
        .isolation_root
        .as_deref()
        .expect("strict caller checked above");
    let canonical_root = fs::canonicalize(raw_root)
        .map_err(|error| format!("failed to canonicalize isolation root '{raw_root}': {error}"))?;
    let requested_cwd = request
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| canonical_root.clone());
    let rooted_cwd = if requested_cwd.is_absolute() {
        requested_cwd
    } else {
        canonical_root.join(requested_cwd)
    };
    let canonical_cwd = fs::canonicalize(&rooted_cwd).map_err(|error| {
        format!(
            "failed to canonicalize cwd '{}' inside isolation root: {error}",
            rooted_cwd.display()
        )
    })?;
    if !canonical_cwd.starts_with(&canonical_root) {
        return Err(format!(
            "cwd '{}' must stay inside isolation root '{}'",
            canonical_cwd.display(),
            canonical_root.display()
        ));
    }

    if !cfg!(target_os = "macos") {
        return Err(
            "strict runner isolation is unavailable: Seatbelt is supported only on macOS"
                .to_string(),
        );
    }
    if !Path::new("/usr/bin/sandbox-exec").is_file() {
        return Err(
            "strict runner isolation is unavailable: /usr/bin/sandbox-exec is missing".to_string(),
        );
    }

    let canonical_root = canonical_root.to_string_lossy().into_owned();
    let canonical_cwd = canonical_cwd.to_string_lossy().into_owned();
    let executable = resolve_executable(&request.command)?;
    let runtime_dependencies = resolve_runtime_dependencies(&executable)?;
    let executable = executable
        .to_str()
        .ok_or_else(|| "strict runner executable path is not valid UTF-8".to_string())?
        .to_string();
    let profile = build_strict_seatbelt_profile(
        &canonical_root,
        &executable,
        &runtime_dependencies,
        request.allow_network,
    );
    let mut args = vec!["-p".to_string(), profile, executable];
    args.extend(request.args.iter().cloned());
    Ok(SpawnPlan {
        program: "/usr/bin/sandbox-exec".to_string(),
        args,
        cwd: Some(canonical_cwd),
        tmpdir: Some(canonical_root.clone()),
        sandbox_warning: None,
        sandbox_active: true,
        strict_root: Some(canonical_root),
    })
}

fn resolve_executable(command: &str) -> Result<PathBuf, String> {
    let path = env::var_os("PATH").unwrap_or_default();
    for directory in env::split_paths(&path) {
        let candidate = directory.join(command);
        if candidate.is_file() {
            return fs::canonicalize(&candidate).map_err(|error| {
                format!(
                    "failed to canonicalize executable '{}': {error}",
                    candidate.display()
                )
            });
        }
    }
    Err(format!(
        "strict runner isolation could not resolve executable '{command}' on PATH"
    ))
}

#[cfg(target_os = "macos")]
fn resolve_runtime_dependencies(executable: &Path) -> Result<Vec<String>, String> {
    let canonical_executable = canonical_runtime_file(executable)?;
    let executable_path = PathBuf::from(&canonical_executable);
    let mut pending = vec![executable_path.clone()];
    let mut inspected = BTreeSet::new();
    let mut dependencies = BTreeSet::new();

    while let Some(binary) = pending.pop() {
        if !inspected.insert(binary.clone()) {
            continue;
        }
        if inspected.len() > MAX_RUNTIME_DEPENDENCIES {
            return Err(format!(
                "strict runner runtime dependency closure exceeds {MAX_RUNTIME_DEPENDENCIES} files"
            ));
        }

        let (load_paths, rpaths) = read_macho_load_paths(&binary)?;
        for load_path in load_paths {
            if load_path.starts_with("/System/") || load_path.starts_with("/usr/lib/") {
                continue;
            }
            let resolved = resolve_macho_load_path(&load_path, &binary, &executable_path, &rpaths)?;
            let canonical = canonical_runtime_file(&resolved)?;
            if canonical == canonical_executable || !dependencies.insert(canonical.clone()) {
                continue;
            }
            pending.push(PathBuf::from(canonical));
        }
    }

    Ok(dependencies.into_iter().collect())
}

#[cfg(not(target_os = "macos"))]
fn resolve_runtime_dependencies(_executable: &Path) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
fn read_macho_load_paths(binary: &Path) -> Result<(Vec<String>, Vec<String>), String> {
    let dependencies = Command::new("/usr/bin/otool")
        .arg("-L")
        .arg(binary)
        .output()
        .map_err(|error| format!("failed to inspect runtime dependencies: {error}"))?;
    if !dependencies.status.success() {
        return Err(format!(
            "failed to inspect runtime dependencies for '{}': {}",
            binary.display(),
            String::from_utf8_lossy(&dependencies.stderr).trim()
        ));
    }
    let stdout = String::from_utf8(dependencies.stdout)
        .map_err(|_| "runtime dependency output is not valid UTF-8".to_string())?;
    let load_paths = stdout
        .lines()
        .skip(1)
        .filter_map(|line| {
            line.trim()
                .split_once(" (")
                .map(|(path, _)| path.to_string())
        })
        .collect();

    let commands = Command::new("/usr/bin/otool")
        .arg("-l")
        .arg(binary)
        .output()
        .map_err(|error| format!("failed to inspect runtime search paths: {error}"))?;
    if !commands.status.success() {
        return Err(format!(
            "failed to inspect runtime search paths for '{}': {}",
            binary.display(),
            String::from_utf8_lossy(&commands.stderr).trim()
        ));
    }
    let stdout = String::from_utf8(commands.stdout)
        .map_err(|_| "runtime search-path output is not valid UTF-8".to_string())?;
    let mut in_rpath = false;
    let mut rpaths = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line == "cmd LC_RPATH" {
            in_rpath = true;
        } else if in_rpath {
            if let Some(path) = line.strip_prefix("path ") {
                let path = path
                    .split_once(" (offset ")
                    .map(|(path, _)| path)
                    .unwrap_or(path);
                rpaths.push(path.to_string());
                in_rpath = false;
            } else if line.starts_with("cmd ") {
                in_rpath = false;
            }
        }
    }
    Ok((load_paths, rpaths))
}

#[cfg(target_os = "macos")]
fn resolve_macho_load_path(
    load_path: &str,
    loader: &Path,
    executable: &Path,
    rpaths: &[String],
) -> Result<PathBuf, String> {
    let loader_dir = loader.parent().ok_or_else(|| {
        format!(
            "runtime dependency loader '{}' has no parent",
            loader.display()
        )
    })?;
    let executable_dir = executable.parent().ok_or_else(|| {
        format!(
            "strict runner executable '{}' has no parent",
            executable.display()
        )
    })?;
    let expand = |path: &str| -> Option<PathBuf> {
        path.strip_prefix("@loader_path/")
            .map(|suffix| loader_dir.join(suffix))
            .or_else(|| {
                path.strip_prefix("@executable_path/")
                    .map(|suffix| executable_dir.join(suffix))
            })
            .or_else(|| Path::new(path).is_absolute().then(|| PathBuf::from(path)))
    };

    if let Some(path) = expand(load_path) {
        return Ok(path);
    }
    if let Some(suffix) = load_path.strip_prefix("@rpath/") {
        for rpath in rpaths {
            if let Some(base) = expand(rpath) {
                let candidate = base.join(suffix);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    Err(format!(
        "strict runner could not resolve runtime dependency '{load_path}' for '{}'",
        loader.display()
    ))
}

fn canonical_runtime_file(path: &Path) -> Result<String, String> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        format!(
            "failed to canonicalize runtime dependency '{}': {error}",
            path.display()
        )
    })?;
    if !canonical.is_file() {
        return Err(format!(
            "runtime dependency '{}' is not a regular file",
            canonical.display()
        ));
    }
    let canonical = canonical.to_str().ok_or_else(|| {
        format!(
            "runtime dependency path '{}' is not valid UTF-8",
            canonical.display()
        )
    })?;
    if canonical.chars().any(char::is_control) {
        return Err("runtime dependency path contains an SBPL control character".to_string());
    }
    Ok(canonical.to_string())
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

    if let Some(cwd) = plan.cwd.as_deref() {
        command.current_dir(cwd);
    }

    command.env_clear();
    command.env("PATH", env::var("PATH").unwrap_or_default());

    if let Some(tmpdir) = plan.tmpdir.as_deref() {
        command.env("TMPDIR", tmpdir);
    }

    if let Some(root) = plan.strict_root.as_deref() {
        command.env("HOME", root);
    }

    for (key, value) in request.env {
        let strict_boundary_env = plan.strict_root.is_some() && (key == "HOME" || key == "TMPDIR");
        if is_safe_env_key(&key) && !strict_boundary_env {
            command.env(key, value);
        }
    }
    if plan.strict_root.is_some() {
        // Homebrew's OpenSSL build points at an owner-writable global config.
        // Strict offline execution must not widen the filesystem boundary just
        // to initialize crypto, nor may the request redirect this config read.
        command.env("OPENSSL_CONF", "/dev/null");
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
        error: if timed_out {
            Some(describe_timeout(timeout.as_millis()))
        } else {
            None
        },
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
    // A timed-out or disconnected drainer means the captured stream is unknown,
    // never complete. Preserve the runner response but surface `truncated` so a
    // caller cannot treat an empty fallback as a clean command result.
    drainer
        .recv_timeout(DRAIN_RECV_TIMEOUT)
        .unwrap_or_else(|_| (String::new(), true))
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
                        truncated = append_capped(&mut kept, &buffer[..read], max_output_bytes)
                            || truncated;
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
    "NODE_OPTIONS",
    "NODE_PATH",
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "PERL5OPT",
    "PERL5DB",
    "PERLLIB",
    "PERL5LIB",
    "PYTHONSTARTUP",
    "PYTHONPATH",
    "PYTHONINSPECT",
    "PYTHONHOME",
    "RUBYOPT",
    "RUBYLIB",
    "GEM_HOME",
    "GEM_PATH",
    // JVM honors -javaagent via *_JAVA_OPTIONS on startup; CLASSPATH/LESSOPEN same class.
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "CLASSPATH",
    "LESSOPEN",
    // PATH is the ONLY resolution path for a bare command name (a `/` is rejected),
    // so a model-set PATH redirects a guard-passing name to an attacker binary.
    // Strip it; the runner-set PATH (above) resolves normal commands.
    "PATH",
    "OPENSSL_CONF",
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_PROXY_COMMAND",
    "GIT_ASKPASS",
    "EDITOR",
    "VISUAL",
    // Git discovers subcommands from GIT_EXEC_PATH and copies hooks from its
    // template directory. Both turn a guard-approved `git` command into an
    // arbitrary executable path controlled by the request environment.
    "GIT_EXEC_PATH",
    "GIT_TEMPLATE_DIR",
    "GIT_DIR",
    "GIT_COMMON_DIR",
    // GIT_CONFIG* point git at an attacker config (core.sshCommand / core.pager)
    // — a second path to the command-exec hooks above.
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    // Cargo can replace every compiler/doc/formatter invocation, configure a
    // registry credential provider, or hand execution to an arbitrary browser.
    "CARGO",
    "CARGO_BUILD_RUSTC",
    "CARGO_BUILD_RUSTC_WRAPPER",
    "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
    "CARGO_BUILD_RUSTDOC",
    "CARGO_BUILD_TARGET",
    "CARGO_BUILD_RUSTFLAGS",
    "CARGO_BUILD_RUSTDOCFLAGS",
    "CARGO_REGISTRY_CREDENTIAL_PROVIDER",
    "CARGO_REGISTRY_GLOBAL_CREDENTIAL_PROVIDERS",
    // The runner starts from env_clear(); accepting these overrides would
    // re-enable user-controlled Cargo/Git global configuration discovery.
    "CARGO_HOME",
    "HOME",
    "XDG_CONFIG_HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "RUSTC",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTDOC",
    "RUSTDOCFLAGS",
    "RUSTFLAGS",
    "CARGO_ENCODED_RUSTDOCFLAGS",
    "CARGO_ENCODED_RUSTFLAGS",
    "RUSTFMT",
    // Rustup proxy binaries honor both a selected toolchain (including an
    // absolute custom-toolchain path) and an alternate toolchain/config root.
    "RUSTUP_HOME",
    "RUSTUP_TOOLCHAIN",
    "BROWSER",
    "PAGER",
    "MANPAGER",
    // OpenSSH invokes the configured askpass helper and loads a requested
    // security-key provider library before it ever reaches the remote host.
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "SSH_SK_PROVIDER",
];

const UNSAFE_ENV_PREFIXES: &[&str] = &[
    // Git uses numbered GIT_CONFIG_KEY_n/VALUE_n variables to inject config.
    "GIT_CONFIG_",
    // Cargo target runners/linkers/rustflags are executable or tool-loading
    // configuration paths; permit target selection through command arguments.
    "CARGO_TARGET_",
];

fn is_safe_env_key(key: &str) -> bool {
    !key.is_empty()
        && !["LD_", "DYLD_"]
            .iter()
            .any(|prefix| key.starts_with(prefix))
        && !UNSAFE_ENV_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
        && !(key.starts_with("CARGO_REGISTRIES_") && key.ends_with("_CREDENTIAL_PROVIDER"))
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
    profile.push_str(
        "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n",
    );

    if let Some(cwd) = spec.cwd {
        profile.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            escape_sbpl_string(cwd)
        ));
    }
    profile.push_str(&format!(
        "(allow file-write* (subpath \"{}\"))\n",
        escape_sbpl_string(spec.tmpdir)
    ));
    // Some tools hardcode `/tmp` rather than reading `$TMPDIR` — on macOS that
    // is itself a symlink to `/private/tmp`, so allow it explicitly alongside
    // the canonicalized `spec.tmpdir` rather than relying on the two coinciding.
    profile.push_str("(allow file-write* (subpath \"/private/tmp\"))\n");

    if let Some(home) = spec.home {
        let home = home.trim_end_matches('/');
        for suffix in RW_CACHE_HOME_SUBPATHS {
            let path = format!("{home}/{suffix}");
            profile.push_str(&format!(
                "(allow file-write* (subpath \"{}\"))\n",
                escape_sbpl_string(&path)
            ));
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

/// Strict profile for caller-scoped eval/code execution. Unlike the normal
/// local runner sandbox, this boundary protects confidentiality as well as
/// integrity: fixture-external file contents are not readable.
fn build_strict_seatbelt_profile(
    isolation_root: &str,
    executable: &str,
    runtime_dependencies: &[String],
    allow_network: bool,
) -> String {
    let root = escape_sbpl_string(isolation_root);
    let executable = escape_sbpl_string(executable);
    let mut profile = String::new();
    profile.push_str("(version 1)\n");
    profile.push_str("(deny default)\n\n");
    profile.push_str("(allow process-fork)\n");
    profile.push_str(&format!(
        "(allow process-exec (literal \"{executable}\"))\n"
    ));
    profile.push_str("(allow signal (target self))\n");
    profile.push_str("(allow sysctl-read)\n");
    profile.push('\n');

    // Metadata is needed to traverse to the fixture and resolve executables;
    // file contents remain deny-by-default outside the explicit roots below.
    profile.push_str("(allow file-read-metadata)\n");
    // dyld/libSystem opens the root directory during process startup on current
    // macOS. This permits only that directory object, not any child contents.
    profile.push_str("(allow file-read-data (literal \"/\"))\n");
    profile.push_str(&format!("(allow file-read* (subpath \"{root}\"))\n"));
    profile.push_str(&format!("(allow file-read* (literal \"{executable}\"))\n"));
    for dependency in runtime_dependencies {
        profile.push_str(&format!(
            "(allow file-read* (literal \"{}\"))\n",
            escape_sbpl_string(dependency)
        ));
    }
    // Only immutable Apple runtime libraries are shared with the child. Broad
    // package/config roots such as /usr, /Library, and /opt are intentionally
    // excluded: they can contain owner-installed and owner-writable secrets.
    for system_root in ["/System", "/usr/lib"] {
        profile.push_str(&format!("(allow file-read* (subpath \"{system_root}\"))\n"));
    }
    profile.push_str("(allow file-read* (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\"))\n\n");

    profile.push_str("(allow file-write-data (literal \"/dev/null\"))\n");
    profile.push_str(&format!("(allow file-write* (subpath \"{root}\"))\n"));
    if allow_network {
        profile.push_str("\n(allow network*)\n");
    }
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
        let response = run_request(
            RunnerRequest {
                command: " ".to_string(),
                args: vec![],
                cwd: None,
                env: BTreeMap::new(),
                timeout_ms: None,
                max_output_bytes: None,
                allow_network: false,
                isolation_root: None,
            },
            SandboxMode::Disabled,
        );

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("command must not be blank"));
    }

    #[test]
    fn strips_path_and_code_injection_env_vars() {
        // PATH would redirect a bare command name (a `/` is rejected) to an
        // attacker binary, bypassing the command guard; *_JAVA_OPTIONS / PYTHONHOME
        // / loader vars are the same interpreter-startup code-exec class.
        for key in [
            "PATH",
            "NODE_OPTIONS",
            "NODE_PATH",
            "JAVA_TOOL_OPTIONS",
            "_JAVA_OPTIONS",
            "JDK_JAVA_OPTIONS",
            "PYTHONHOME",
            "CLASSPATH",
            "LESSOPEN",
            "GEM_HOME",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "GIT_SSH_COMMAND",
        ] {
            assert!(!is_safe_env_key(key), "{key} must be rejected");
        }
        assert!(is_safe_env_key("MUSE_OK"));
        assert!(is_safe_env_key("TERM"));
    }

    #[test]
    fn rejects_path_commands_to_avoid_shell_like_execution() {
        let response = run_request(
            RunnerRequest {
                command: "/bin/echo".to_string(),
                args: vec!["hello".to_string()],
                cwd: None,
                env: BTreeMap::new(),
                timeout_ms: None,
                max_output_bytes: None,
                allow_network: false,
                isolation_root: None,
            },
            SandboxMode::Disabled,
        );

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
        let response = run_request(
            RunnerRequest {
                command: "bash".to_string(),
                args: vec![
                    "-c".to_string(),
                    "head -c 200000 /dev/zero | tr '\\0' a".to_string(),
                ],
                cwd: None,
                env: BTreeMap::new(),
                timeout_ms: Some(10_000),
                max_output_bytes: Some(1_000_000),
                allow_network: false,
                isolation_root: None,
            },
            SandboxMode::Disabled,
        );

        assert!(
            !response.timed_out,
            "large output must not be killed as a timeout"
        );
        assert!(response.ok, "a command that exits 0 must report ok");
        assert_eq!(response.stdout.len(), 200_000);
        assert!(!response.truncated);
    }

    #[test]
    fn caps_output_without_blocking_when_it_exceeds_max_bytes() {
        let response = run_request(
            RunnerRequest {
                command: "bash".to_string(),
                args: vec![
                    "-c".to_string(),
                    "head -c 200000 /dev/zero | tr '\\0' a".to_string(),
                ],
                cwd: None,
                env: BTreeMap::new(),
                timeout_ms: Some(10_000),
                max_output_bytes: Some(1024),
                allow_network: false,
                isolation_root: None,
            },
            SandboxMode::Disabled,
        );

        assert!(!response.timed_out);
        assert!(response.ok);
        // stdout is the capped 1024 bytes of program output PLUS the self-labelled
        // in-band truncation marker (the capped content itself is unchanged).
        assert!(
            response.stdout.starts_with(&"a".repeat(1024)),
            "the capped program output is preserved"
        );
        assert!(
            response.stdout.contains("[muse: output truncated"),
            "a truncated stream carries the in-band marker"
        );
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
        for key in [
            "NODE_OPTIONS",
            "BASH_ENV",
            "ENV",
            "SHELLOPTS",
            "PERL5OPT",
            "PYTHONSTARTUP",
            "PYTHONPATH",
            "RUBYOPT",
            "OPENSSL_CONF",
            "GIT_SSH_COMMAND",
            "GIT_EXTERNAL_DIFF",
            "GIT_PAGER",
            "GIT_PROXY_COMMAND",
            "GIT_CONFIG",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
        ] {
            assert!(!is_safe_env_key(key), "{key} must be rejected");
        }
        // Legitimate, similarly-named vars survive.
        for key in ["NODE_ENV", "GIT_WORK_TREE", "GIT_AUTHOR_NAME", "MY_FLAG"] {
            assert!(is_safe_env_key(key), "{key} must be allowed");
        }
    }

    #[test]
    fn rejects_vcs_toolchain_and_ssh_execution_environment() {
        // Each variable below is documented by its owning tool as choosing an
        // executable, executable search path, hook template, or loaded library.
        for key in [
            "GIT_EXEC_PATH",
            "GIT_TEMPLATE_DIR",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GIT_DIR",
            "GIT_COMMON_DIR",
            "GIT_EDITOR",
            "GIT_SEQUENCE_EDITOR",
            "EDITOR",
            "VISUAL",
            "RUSTC",
            "RUSTC_WRAPPER",
            "RUSTC_WORKSPACE_WRAPPER",
            "RUSTDOC",
            "RUSTFMT",
            "RUSTFLAGS",
            "CARGO_BUILD_RUSTC",
            "CARGO_BUILD_RUSTC_WRAPPER",
            "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
            "CARGO_BUILD_RUSTDOC",
            "CARGO_BUILD_TARGET",
            "CARGO_BUILD_RUSTFLAGS",
            "CARGO_BUILD_RUSTDOCFLAGS",
            "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER",
            "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER",
            "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS",
            "CARGO_REGISTRY_CREDENTIAL_PROVIDER",
            "CARGO_REGISTRIES_PRIVATE_CREDENTIAL_PROVIDER",
            "CARGO_HOME",
            "HOME",
            "XDG_CONFIG_HOME",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "RUSTUP_HOME",
            "RUSTUP_TOOLCHAIN",
            "SSH_ASKPASS",
            "SSH_ASKPASS_REQUIRE",
            "SSH_SK_PROVIDER",
            "BROWSER",
        ] {
            assert!(!is_safe_env_key(key), "{key} must be rejected");
        }
        assert!(is_safe_env_key("GIT_AUTHOR_NAME"));
        assert!(is_safe_env_key("MUSE_RUNNER_LABEL"));
    }

    #[test]
    fn timeout_message_is_actionable() {
        let msg = describe_timeout(5000);
        assert!(msg.contains("5000ms"), "names the elapsed timeout: {msg}");
        assert!(
            msg.contains("timed out") && msg.contains("killed"),
            "explains the kill: {msg}"
        );
        assert!(
            msg.contains("timeoutMs"),
            "tells the model how to react: {msg}"
        );
        // A timeout means the command needed MORE time than the budget — so the
        // remediation must advise a LARGER timeout, never a smaller one (a smaller
        // budget kills the retry sooner). Pin the DIRECTION, not just the token
        // (JUDGE-DRILL #4: "smaller timeoutMs" passed a contains-only check).
        assert!(
            msg.contains("larger"),
            "advises MORE time on a timeout: {msg}"
        );
        assert!(
            !msg.contains("smaller"),
            "never advises a smaller timeout — it would kill the retry sooner: {msg}"
        );
        assert!(!msg.contains("os error"), "no raw errno: {msg}");
    }

    #[cfg(unix)]
    #[test]
    fn run_request_surfaces_the_timeout_message_end_to_end() {
        // a real command that outlives a tiny timeout → killed → the model must
        // receive BOTH timed_out=true AND the actionable error message (not None).
        let resp = run_request(
            RunnerRequest {
                command: "sleep".to_string(),
                args: vec!["5".to_string()],
                cwd: None,
                env: std::collections::BTreeMap::new(),
                timeout_ms: Some(50),
                max_output_bytes: None,
                allow_network: false,
                isolation_root: None,
            },
            SandboxMode::Disabled,
        );
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
        let response = run_request(
            RunnerRequest {
                command: "sh".to_string(),
                args: vec!["-c".to_string(), script],
                cwd: None,
                env: BTreeMap::new(),
                timeout_ms: Some(5_000),
                max_output_bytes: None,
                allow_network: false,
                isolation_root: None,
            },
            SandboxMode::Disabled,
        );
        let elapsed = started.elapsed();

        assert!(
            response.ok,
            "the direct child completes normally: {response:?}"
        );
        assert!(
            !response.timed_out,
            "the direct child exits well within the 5s timeout: {response:?}"
        );
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
        let nf = describe_spawn_error(
            "pytest",
            &Error::new(
                ErrorKind::NotFound,
                "No such file or directory (os error 2)",
            ),
        );
        assert!(nf.contains("pytest"), "names the command: {nf}");
        assert!(
            nf.contains("not found") && nf.contains("PATH"),
            "actionable: {nf}"
        );
        assert!(!nf.contains("os error"), "no raw errno: {nf}");
        // sibling: not-executable
        let pd = describe_spawn_error(
            "script.sh",
            &Error::new(ErrorKind::PermissionDenied, "denied"),
        );
        assert!(
            pd.contains("script.sh") && pd.contains("not executable"),
            "perm: {pd}"
        );
        // anything else falls through to the generic message (unchanged).
        let other = describe_spawn_error("x", &Error::other("weird failure"));
        assert!(
            other.contains("failed to spawn command") && other.contains("weird failure"),
            "generic: {other}"
        );
    }

    #[test]
    fn clamps_resource_knobs_to_sane_bounds() {
        // Huge values clamp to the ceiling; sane values pass; absent → default.
        assert_eq!(effective_timeout_ms(Some(999_999_999)), MAX_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(Some(5_000)), 5_000);
        assert_eq!(effective_timeout_ms(Some(0)), 1);
        assert_eq!(effective_timeout_ms(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(
            effective_max_output_bytes(Some(5_000_000_000)),
            MAX_OUTPUT_BYTES
        );
        assert_eq!(effective_max_output_bytes(Some(1024)), 1024);
        assert_eq!(effective_max_output_bytes(None), DEFAULT_MAX_OUTPUT_BYTES);
    }

    #[test]
    fn seatbelt_profile_has_the_version_header_and_denies_by_default() {
        let spec = SeatbeltSpec {
            cwd: None,
            tmpdir: "/tmp",
            home: None,
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.starts_with("(version 1)\n"),
            "version header must lead the profile: {profile}"
        );
        assert!(
            profile.contains("(deny default)"),
            "profile must deny by default: {profile}"
        );
    }

    #[test]
    fn strict_isolation_profile_reads_and_writes_only_the_fixture_plus_system_runtime() {
        let dependencies = vec!["/opt/homebrew/Cellar/node/24.0.0/lib/libnode.dylib".to_string()];
        let profile = build_strict_seatbelt_profile(
            "/private/tmp/muse-fixture",
            "/usr/bin/node",
            &dependencies,
            false,
        );
        assert!(
            profile.contains("(allow file-read* (subpath \"/private/tmp/muse-fixture\"))"),
            "fixture contents must be readable: {profile}"
        );
        assert!(
            profile.contains("(allow file-write* (subpath \"/private/tmp/muse-fixture\"))"),
            "fixture contents must be writable: {profile}"
        );
        assert!(
            !profile
                .lines()
                .any(|line| line.trim() == "(allow file-read*)"),
            "strict isolation must not retain the broad external-read allowance: {profile}"
        );
        assert!(
            profile.contains("(allow file-read-data (literal \"/\"))"),
            "macOS runtime gets the root directory object only, never a root subpath allowance: {profile}"
        );
        assert!(
            !profile.contains("(allow file-read* (subpath \"/\"))"),
            "root descendants must remain denied: {profile}"
        );
        assert!(
            !profile.contains("Library/pnpm/store"),
            "strict isolation must not expose owner caches: {profile}"
        );
        assert!(
            profile.contains("(allow process-exec (literal \"/usr/bin/node\"))"),
            "only the resolved executable may run: {profile}"
        );
        assert!(
            profile.contains("(allow file-read* (literal \"/opt/homebrew/Cellar/node/24.0.0/lib/libnode.dylib\"))"),
            "runtime dependencies must be exact-file reads: {profile}"
        );
        assert!(
            !profile.contains("process-exec*"),
            "strict isolation must not execute arbitrary binaries: {profile}"
        );
        assert!(
            !profile.contains("(allow mach-lookup)"),
            "strict isolation must not expose arbitrary Mach services: {profile}"
        );
        for forbidden in [
            "(subpath \"/opt",
            "(subpath \"/Library",
            "/usr\"",
            "/private/etc",
            "/private/var/db",
            "(subpath \"/dev\")",
        ] {
            assert!(
                !profile.contains(forbidden),
                "mutable or overly broad runtime root must stay denied ({forbidden}): {profile}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn runtime_dependency_paths_are_canonicalized_and_control_characters_fail_closed() {
        use std::os::unix::fs::symlink;

        let base =
            std::env::temp_dir().join(format!("muse-runner-runtime-path-{}", std::process::id()));
        fs::create_dir_all(&base).expect("runtime path fixture must be creatable");
        let target = base.join("runtime.dylib");
        let link = base.join("runtime-link.dylib");
        fs::write(&target, "runtime").expect("runtime target must be writable");
        symlink(&target, &link).expect("runtime symlink must be creatable");

        assert_eq!(
            canonical_runtime_file(&link).expect("symlink must resolve to its exact target"),
            fs::canonicalize(&target)
                .unwrap()
                .to_str()
                .unwrap()
                .to_string()
        );

        let injected = base.join("runtime\n(allow file-read*)\n.dylib");
        fs::write(&injected, "runtime").expect("injection probe must be writable");
        assert!(
            canonical_runtime_file(&injected).is_err(),
            "control characters must never reach an SBPL literal"
        );

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn seatbelt_profile_allows_file_reads_broadly() {
        let spec = SeatbeltSpec {
            cwd: None,
            tmpdir: "/tmp",
            home: None,
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-read*)"),
            "reads are not the gated threat: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_allows_write_under_cwd_when_present() {
        let spec = SeatbeltSpec {
            cwd: Some("/tmp/work"),
            tmpdir: "/var/tmp",
            home: None,
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-write* (subpath \"/tmp/work\"))"),
            "cwd must get a write rule: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_has_no_cwd_write_rule_when_cwd_absent() {
        let spec = SeatbeltSpec {
            cwd: None,
            tmpdir: "/var/tmp",
            home: None,
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        // The tmpdir rule and the always-on /private/tmp rule should be present —
        // no other subpath rule (i.e. no cwd rule).
        let write_rule_count = profile.matches("(allow file-write*").count();
        assert_eq!(
            write_rule_count, 2,
            "tmpdir + /private/tmp only, no cwd rule: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_always_allows_write_under_tmpdir() {
        let spec = SeatbeltSpec {
            cwd: None,
            tmpdir: "/private/var/tmp",
            home: None,
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-write* (subpath \"/private/var/tmp\"))"),
            "tmpdir must always get a write rule: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_allows_dev_null_and_dtracehelper_writes() {
        let spec = SeatbeltSpec {
            cwd: None,
            tmpdir: "/tmp",
            home: None,
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains(
                "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))"
            ),
            "sh/git write to /dev/null and dtrace helper must be allowed: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_always_allows_write_under_private_tmp() {
        let spec = SeatbeltSpec {
            cwd: None,
            tmpdir: "/var/folders/x/y",
            home: None,
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-write* (subpath \"/private/tmp\"))"),
            "a tool hard-coding /tmp must not false-positive even when TMPDIR differs: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_denies_network_by_default_and_allows_when_requested() {
        let denied = build_seatbelt_profile(&SeatbeltSpec {
            cwd: None,
            tmpdir: "/tmp",
            home: None,
            allow_network: false,
        });
        assert!(
            !denied.contains("(allow network*)"),
            "network must not be allowed by default: {denied}"
        );

        let allowed = build_seatbelt_profile(&SeatbeltSpec {
            cwd: None,
            tmpdir: "/tmp",
            home: None,
            allow_network: true,
        });
        assert_eq!(
            allowed.matches("(allow network*)").count(),
            1,
            "exactly one network allowance when opted in: {allowed}"
        );
    }

    #[test]
    fn seatbelt_profile_expands_home_into_absolute_cache_write_rules() {
        let spec = SeatbeltSpec {
            cwd: None,
            tmpdir: "/tmp",
            home: Some("/Users/x"),
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            profile.contains("(allow file-write* (subpath \"/Users/x/Library/pnpm/store\"))"),
            "{profile}"
        );
        assert!(
            profile.contains("(allow file-write* (subpath \"/Users/x/.npm\"))"),
            "{profile}"
        );
        assert!(
            profile.contains("(allow file-write* (subpath \"/Users/x/.cache\"))"),
            "{profile}"
        );
        assert!(
            !profile.contains('~'),
            "no literal tilde — SBPL never expands it: {profile}"
        );
    }

    #[test]
    fn seatbelt_profile_omits_cache_write_rules_when_home_is_absent() {
        let spec = SeatbeltSpec {
            cwd: None,
            tmpdir: "/tmp",
            home: None,
            allow_network: false,
        };
        let profile = build_seatbelt_profile(&spec);
        assert!(
            !profile.contains("pnpm/store"),
            "no pnpm cache rule without a home: {profile}"
        );
        assert!(
            !profile.contains(".npm"),
            "no npm cache rule without a home: {profile}"
        );
        assert!(
            !profile.contains(".cache"),
            "no generic cache rule without a home: {profile}"
        );
        assert!(
            !profile.contains('~'),
            "no literal tilde stand-in either: {profile}"
        );
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
        assert!(profile.contains(
            "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))"
        ));
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
            escaped, r#"/tmp/evil\"))(allow network*)(dummy \"path\\end"#,
            "every quote and backslash must be escaped exactly: {escaped}"
        );
        // Splicing the escaped form into a double-quoted SBPL literal must not
        // let an unescaped `"` close the string early.
        assert!(
            !would_close_early(&escaped),
            "no unescaped quote should close the SBPL string early: {escaped}"
        );
    }

    #[test]
    fn escape_sbpl_string_strips_control_characters() {
        let raw = "/tmp/evil\n(allow network*)\t\r";
        let escaped = escape_sbpl_string(raw);
        assert_eq!(
            escaped, "/tmp/evil(allow network*)",
            "control chars are stripped, not passed through: {escaped}"
        );
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
            isolation_root: None,
        }
    }

    #[test]
    fn disabled_plan_is_an_identical_passthrough() {
        let plan = spawn_plan(&sample_request(), SandboxMode::Disabled)
            .expect("disabled mode never fails to plan");
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
        assert!(
            !plan.sandbox_active,
            "unsupported platform never actually sandboxes"
        );
        let warning = plan
            .sandbox_warning
            .expect("a requested-but-unsupported sandbox must surface a warning");
        assert!(
            warning.contains("seatbelt"),
            "names the requested mechanism: {warning}"
        );
        assert!(
            warning.to_lowercase().contains("unsandboxed")
                || warning.to_lowercase().contains("without"),
            "says the command still ran: {warning}"
        );
    }

    #[test]
    fn strict_isolation_rejects_an_external_cwd_before_planning_a_child() {
        let root =
            std::env::temp_dir().join(format!("muse-runner-strict-root-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("muse-runner-strict-outside-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("strict root must be creatable");
        std::fs::create_dir_all(&outside).expect("outside cwd must be creatable");
        let mut request = sample_request();
        request.cwd = Some(outside.to_string_lossy().into_owned());
        request.isolation_root = Some(root.to_string_lossy().into_owned());

        let error = spawn_plan(&request, SandboxMode::Disabled).expect_err(
            "strict isolation must reject cwd outside its canonical root before any spawn",
        );
        assert!(
            error.contains("cwd") && error.contains("isolation root"),
            "actionable boundary error: {error}"
        );

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn strict_isolation_rejects_a_cwd_symlink_to_outside_the_root() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "muse-runner-strict-link-root-{}",
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "muse-runner-strict-link-outside-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("strict root must be creatable");
        std::fs::create_dir_all(&outside).expect("outside cwd must be creatable");
        let escape = root.join("escape");
        symlink(&outside, &escape).expect("symlink probe must be creatable");
        let mut request = sample_request();
        request.cwd = Some(escape.to_string_lossy().into_owned());
        request.isolation_root = Some(root.to_string_lossy().into_owned());

        let error = spawn_plan(&request, SandboxMode::Disabled)
            .expect_err("canonical symlink target outside the root must fail before spawn");
        assert!(
            error.contains("cwd") && error.contains("isolation root"),
            "actionable boundary error: {error}"
        );

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_plan_wraps_the_command_in_sandbox_exec_with_a_canonicalized_cwd_rule() {
        let dir = std::env::temp_dir();
        let canonical_dir =
            std::fs::canonicalize(&dir).expect("temp dir must canonicalize on a real machine");
        let request = RunnerRequest {
            command: "node".to_string(),
            args: vec!["report.mjs".to_string(), "--flag".to_string()],
            cwd: Some(dir.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            timeout_ms: None,
            max_output_bytes: None,
            allow_network: false,
            isolation_root: None,
        };
        let plan =
            spawn_plan(&request, SandboxMode::Seatbelt).expect("a real temp dir must canonicalize");
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
            isolation_root: None,
        };
        // On non-macOS this mode never actually resolves to Seatbelt via
        // `resolve_sandbox_mode`, but `spawn_plan` itself is exercised directly
        // here regardless of platform to prove the fail-close path.
        let result = spawn_plan(&request, SandboxMode::Seatbelt);
        assert!(
            result.is_err(),
            "an unresolvable cwd must fail closed, never fall back to unsandboxed"
        );
    }

    #[test]
    fn response_with_no_sandbox_warning_serializes_without_the_field() {
        let response = error_response("boom");
        let json = serde_json::to_string(&response).expect("response must serialize");
        assert!(
            !json.contains("sandboxWarning"),
            "an absent warning must not appear in the JSON at all: {json}"
        );
    }

    #[test]
    fn response_with_a_sandbox_warning_serializes_it_as_camel_case() {
        let mut response = error_response("boom");
        response.sandbox_warning = Some("seatbelt unsupported here".to_string());
        let json = serde_json::to_string(&response).expect("response must serialize");
        assert!(
            json.contains("\"sandboxWarning\":\"seatbelt unsupported here\""),
            "warning must serialize camelCase: {json}"
        );
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

    fn seatbelt_request(
        cwd: &Path,
        command: &str,
        args: Vec<String>,
        allow_network: bool,
    ) -> RunnerRequest {
        RunnerRequest {
            command: command.to_string(),
            args,
            cwd: Some(cwd.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            timeout_ms: Some(10_000),
            max_output_bytes: Some(1_000_000),
            allow_network,
            isolation_root: None,
        }
    }

    fn strict_request(root: &Path, command: &str, args: Vec<String>) -> RunnerRequest {
        let mut request = seatbelt_request(root, command, args, false);
        request.isolation_root = Some(root.to_string_lossy().into_owned());
        request
    }

    #[test]
    fn strict_isolation_allows_fixture_execution_but_blocks_external_file_reads() {
        if !sandbox_exec_available() {
            eprintln!("skipping: /usr/bin/sandbox-exec not present on this machine");
            return;
        }
        let base =
            std::env::temp_dir().join(format!("muse-runner-strict-read-{}", std::process::id()));
        let root = base.join("fixture");
        let outside = base.join("owner-readme.md");
        fs::create_dir_all(&root).expect("strict fixture must be creatable");
        fs::write(root.join("inside.txt"), "fixture-visible")
            .expect("inside fixture must be writable");
        fs::write(&outside, "OWNER-PRIVATE-SENTINEL").expect("external probe must be writable");

        let allowed = run_request(
            strict_request(&root, "cat", vec!["inside.txt".to_string()]),
            SandboxMode::Disabled,
        );
        assert!(
            allowed.ok,
            "fixture-local read must work under strict isolation: {allowed:?}"
        );
        assert!(
            allowed.stdout.contains("fixture-visible"),
            "fixture contents must reach the caller: {allowed:?}"
        );

        let denied = run_request(
            strict_request(&root, "cat", vec![outside.to_string_lossy().into_owned()]),
            SandboxMode::Disabled,
        );
        assert!(
            !denied.ok,
            "an absolute fixture-external read must be denied: {denied:?}"
        );
        assert!(
            !denied.stdout.contains("OWNER-PRIVATE-SENTINEL"),
            "external contents must never reach stdout: {denied:?}"
        );

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn strict_isolation_runs_a_node_fixture_but_blocks_the_workspace_readme() {
        if !sandbox_exec_available() {
            eprintln!("skipping: /usr/bin/sandbox-exec not present on this machine");
            return;
        }
        let root =
            std::env::temp_dir().join(format!("muse-runner-strict-node-{}", std::process::id()));
        fs::create_dir_all(&root).expect("strict node fixture must be creatable");
        fs::write(
            root.join("fixture.test.mjs"),
            "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('strict node fixture', () => { assert.equal(2 + 3, 5); });\n"
        )
            .expect("fixture script must be writable");

        let allowed = run_request(
            strict_request(
                &root,
                "node",
                vec!["--test".to_string(), "fixture.test.mjs".to_string()],
            ),
            SandboxMode::Disabled,
        );
        assert!(
            allowed.ok,
            "node fixture must execute under strict isolation: {allowed:?}"
        );
        assert!(
            allowed.stdout.contains("strict node fixture"),
            "node test output must be grounded in the fixture: {allowed:?}"
        );

        let workspace_readme =
            fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../README.md"))
                .expect("workspace README probe must exist");
        let script =
            "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))";
        let denied = run_request(
            strict_request(
                &root,
                "node",
                vec![
                    "-e".to_string(),
                    script.to_string(),
                    workspace_readme.to_string_lossy().into_owned(),
                ],
            ),
            SandboxMode::Disabled,
        );
        assert!(
            !denied.ok,
            "node must not read the fixture-external workspace README: {denied:?}"
        );
        assert!(
            denied.stdout.is_empty(),
            "external README contents must never reach stdout: {denied:?}"
        );

        let homebrew_probe = Path::new("/opt/homebrew/README.md");
        if homebrew_probe.exists() {
            let denied_homebrew = run_request(
                strict_request(
                    &root,
                    "node",
                    vec![
                        "-e".to_string(),
                        script.to_string(),
                        homebrew_probe.to_string_lossy().into_owned(),
                    ],
                ),
                SandboxMode::Disabled,
            );
            assert!(
                !denied_homebrew.ok,
                "Homebrew Node must not gain owner-writable Homebrew contents through its runtime dependency allowlist: {denied_homebrew:?}"
            );
            assert!(
                denied_homebrew.stdout.is_empty(),
                "Homebrew contents must never reach stdout: {denied_homebrew:?}"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legit_command_succeeds_under_seatbelt() {
        if !sandbox_exec_available() {
            eprintln!("skipping: /usr/bin/sandbox-exec not present on this machine");
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("muse-runner-seatbelt-ok-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("test temp dir must be creatable");
        let marker = dir.join("marker.txt");

        let script = format!(
            "echo hello > {marker} && cat {marker} && echo tmp-ok > \"$TMPDIR/muse-runner-tmp-{pid}.txt\" && echo x > /dev/null",
            marker = marker.to_string_lossy(),
            pid = std::process::id()
        );
        let request = seatbelt_request(&dir, "sh", vec!["-c".to_string(), script], false);
        let response = run_request(request, SandboxMode::Seatbelt);

        assert!(
            response.ok,
            "a legitimate command must succeed under seatbelt: {response:?}"
        );
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
        let dir = std::env::temp_dir().join(format!(
            "muse-runner-seatbelt-escape1-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("test temp dir must be creatable");
        let target = format!(
            "/private/var/tmp/muse-runner-escape-{}.txt",
            std::process::id()
        );

        let request = seatbelt_request(
            &dir,
            "sh",
            vec!["-c".to_string(), format!("echo x > {target}")],
            false,
        );
        let response = run_request(request, SandboxMode::Seatbelt);

        assert!(
            !response.ok,
            "a write outside cwd/tmpdir must be denied: {response:?}"
        );
        assert!(
            !Path::new(&target).exists(),
            "the escape write must not have landed on disk"
        );

        let _ = fs::remove_file(&target);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn escape_write_to_home_ssh_is_blocked() {
        if !sandbox_exec_available() {
            eprintln!("skipping: /usr/bin/sandbox-exec not present on this machine");
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "muse-runner-seatbelt-escape2-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("test temp dir must be creatable");

        let home = env::var("HOME").expect("HOME must be set to run this test");
        let ssh_dir = Path::new(&home).join(".ssh");
        let target = if ssh_dir.is_dir() {
            ssh_dir.join(format!("muse-runner-escape-{}.txt", std::process::id()))
        } else {
            Path::new(&home).join(format!("muse-runner-escape-{}.txt", std::process::id()))
        };

        let request = seatbelt_request(
            &dir,
            "sh",
            vec![
                "-c".to_string(),
                format!("echo x > {}", target.to_string_lossy()),
            ],
            false,
        );
        let response = run_request(request, SandboxMode::Seatbelt);

        assert!(
            !response.ok,
            "a write to a home-sensitive path must be denied: {response:?}"
        );
        assert!(
            !target.exists(),
            "the escape write must not have landed on disk"
        );

        let _ = fs::remove_file(&target);
        let _ = fs::remove_dir_all(&dir);
    }

    fn accept_once_in_background(listener: TcpListener) -> Arc<AtomicBool> {
        let accepted = Arc::new(AtomicBool::new(false));
        let accepted_flag = Arc::clone(&accepted);
        listener
            .set_nonblocking(false)
            .expect("listener must support blocking accept");
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
        let dir =
            std::env::temp_dir().join(format!("muse-runner-seatbelt-net-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("test temp dir must be creatable");

        // Denied leg: no listener should ever see a connection attempt.
        let denied_listener =
            TcpListener::bind("127.0.0.1:0").expect("must bind a local ephemeral port");
        let denied_port = denied_listener
            .local_addr()
            .expect("bound listener has a local addr")
            .port();
        let denied_accepted = accept_once_in_background(denied_listener);
        let denied_request = seatbelt_request(
            &dir,
            "curl",
            vec![
                "-s".to_string(),
                "--max-time".to_string(),
                "2".to_string(),
                format!("http://127.0.0.1:{denied_port}/"),
            ],
            false,
        );
        let denied_response = run_request(denied_request, SandboxMode::Seatbelt);
        thread::sleep(Duration::from_millis(300));
        assert!(
            !denied_response.ok,
            "curl must fail when network is denied: {denied_response:?}"
        );
        assert!(
            !denied_accepted.load(Ordering::SeqCst),
            "the denied listener must never observe a connection"
        );

        // Allowed leg: connection must be observed (curl's own exit code is not
        // asserted — the listener isn't real HTTP, so curl may still error on a
        // malformed response; what matters is the TCP connection itself lands).
        let allowed_listener =
            TcpListener::bind("127.0.0.1:0").expect("must bind a second local ephemeral port");
        let allowed_port = allowed_listener
            .local_addr()
            .expect("bound listener has a local addr")
            .port();
        let allowed_accepted = accept_once_in_background(allowed_listener);
        let allowed_request = seatbelt_request(
            &dir,
            "curl",
            vec![
                "-s".to_string(),
                "--max-time".to_string(),
                "2".to_string(),
                format!("http://127.0.0.1:{allowed_port}/"),
            ],
            true,
        );
        let _allowed_response = run_request(allowed_request, SandboxMode::Seatbelt);
        thread::sleep(Duration::from_millis(300));
        assert!(
            allowed_accepted.load(Ordering::SeqCst),
            "an opted-in request must be observed connecting"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod request_input_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn request_reader_accepts_a_normal_bounded_json_request() {
        let request = read_request_from(Cursor::new(br#"{"command":"echo"}"#))
            .expect("a normal JSON request should parse");
        assert_eq!(request.command, "echo");
    }

    #[test]
    fn request_reader_rejects_oversized_input_before_json_parsing() {
        let oversized = vec![b' '; MAX_REQUEST_BYTES + 1];
        let error = read_request_from(Cursor::new(oversized))
            .expect_err("oversized input must be rejected before parsing");
        assert!(error.contains("exceeds"), "unexpected error: {error}");
        assert!(
            error.contains(&MAX_REQUEST_BYTES.to_string()),
            "missing limit: {error}"
        );
    }

    #[test]
    fn disconnected_drainer_is_marked_as_incomplete_output() {
        let (sender, receiver) = mpsc::channel();
        drop(sender);
        let (output, truncated) = recv_drained(receiver);
        assert!(output.is_empty());
        assert!(
            truncated,
            "a missing drainer result must never look complete"
        );
    }
}
