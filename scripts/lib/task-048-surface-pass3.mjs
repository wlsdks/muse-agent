export const TASK_048_REPORT_SCHEMA = "muse.personal-agent.surface-clean-process-report/v1";
const SURFACES = new Set(["api", "browser", "cli", "web"]);

export function parseBrowserSmokeOutput(output) {
  if (
    typeof output !== "string"
    || /(?:^|\n)SKIP:/u.test(output)
    || !/(?:^|\n)smoke:browser PASS(?:\n|$)/u.test(output)
  ) {
    throw new Error("Browser smoke did not emit an explicit no-skip PASS");
  }
  const diagnostic = parsePrefixedJson(output, "smoke:browser qualification ");
  if (
    !isPlainObject(diagnostic)
    || diagnostic.type !== "browser-smoke-owned-state"
    || typeof diagnostic.tempRoot !== "string"
    || diagnostic.tempRoot.length === 0
    || !Array.isArray(diagnostic.browserReceipts)
    || diagnostic.browserReceipts.length === 0
    || diagnostic.browserReceipts.some((receipt) => !isBrowserReceipt(receipt))
    || !Array.isArray(diagnostic.profiles)
    || diagnostic.profiles.length !== diagnostic.browserReceipts.length
    || diagnostic.profiles.some((profile) => typeof profile !== "string" || profile.length === 0)
    || !Array.isArray(diagnostic.ports)
    || diagnostic.ports.length !== 1
    || diagnostic.ports.some((port) => !isOwnedPort(port))
  ) {
    throw new Error("Browser smoke ownership diagnostic is incomplete");
  }
  return diagnostic;
}

export function parseCliSmokeOutput(output) {
  if (
    typeof output !== "string"
    || !/(?:^|\n)10 passed, 0 failed(?:\n|$)/u.test(output)
  ) {
    throw new Error("CLI smoke did not emit its exact 10/10 summary");
  }
  const owned = parsePrefixedJson(output, "smoke:cli lifecycle-owned ");
  const lifecycle = parsePrefixedJson(output, "smoke:cli lifecycle ");
  if (
    !isPlainObject(owned)
    || !isProcessGroupReceipt(owned.apiReceipt)
    || !isOwnedPort({ name: "api", port: owned.apiPort })
    || !Number.isSafeInteger(owned.rootPid)
    || owned.rootPid <= 0
    || typeof owned.schedulerRoot !== "string"
    || owned.schedulerRoot.length === 0
    || !isPlainObject(lifecycle)
    || lifecycle.stage !== "post-shutdown"
    || lifecycle.rootPid !== owned.rootPid
    || lifecycle.schedulerRoot !== owned.schedulerRoot
    || !Array.isArray(lifecycle.processes)
    || lifecycle.processes.some((record) =>
      !isPlainObject(record) || record.relationship !== "root" || record.pid !== owned.rootPid
    )
  ) {
    throw new Error("CLI smoke lifecycle diagnostic is incomplete or not clean");
  }
  return { lifecycle, owned };
}

export function parsePersonalAgentE2eOutput(output, expectedTestCount) {
  if (
    typeof output !== "string"
    || !output.includes("personal-agent E2E fixture PASS (local-only, persisted, residue 0)")
  ) {
    throw new Error("personal-agent E2E did not emit its exact PASS marker");
  }
  const ownedState = parseJsonLineByType(output, "personal-agent-e2e-owned-state");
  const qualification = parseJsonLineByType(output, "personal-agent-e2e-qualification");
  const urls = ["apiUrl", "embedUrl", "webUrl"].map((key) =>
    loopbackPort(ownedState?.[key])
  );
  if (
    !isPlainObject(ownedState)
    || !isProcessGroupReceipt(ownedState.playwrightReceipt)
    || typeof ownedState.stateRoot !== "string"
    || ownedState.stateRoot.length === 0
    || urls.some((port) => port === undefined)
    || new Set(urls).size !== urls.length
    || !isPlainObject(qualification)
    || qualification.type !== "personal-agent-e2e-qualification"
    || typeof qualification.runId !== "string"
    || qualification.runId.length === 0
    || !isExactPlaywrightProjection(qualification.playwright, expectedTestCount)
  ) {
    throw new Error("personal-agent E2E qualification diagnostic is incomplete");
  }
  return { ownedState, qualification };
}

export function parsePlaywrightQualificationReport(input, expectedTestCount) {
  if (
    !isPlainObject(input)
    || !Array.isArray(input.errors)
    || input.errors.length !== 0
    || !isPlainObject(input.stats)
    || input.stats.expected !== expectedTestCount
    || input.stats.skipped !== 0
    || input.stats.unexpected !== 0
    || input.stats.flaky !== 0
    || !isNonNegativeFinite(input.stats.duration)
  ) {
    throw new Error("Playwright qualification report is not an exact no-skip pass");
  }
  return {
    durationMs: input.stats.duration,
    expected: input.stats.expected,
    flaky: input.stats.flaky,
    skipped: input.stats.skipped,
    unexpected: input.stats.unexpected
  };
}

export function projectCleanProcessReport(input) {
  if (
    !isPlainObject(input)
    || !SURFACES.has(input.surface)
    || !Number.isSafeInteger(input.trial)
    || input.trial < 1
    || input.trial > 3
    || typeof input.runId !== "string"
    || input.runId.length === 0
    || !isInstant(input.startedAt)
    || !isInstant(input.finishedAt)
    || input.noSkip !== true
    || !isPlainObject(input.terminal)
    || input.terminal.exitCode !== 0
    || input.terminal.signal !== null
    || input.terminal.bounded !== true
    || input.terminal.timedOut !== false
    || !Number.isSafeInteger(input.terminal.timeoutMs)
    || input.terminal.timeoutMs <= 0
    || !isPlainObject(input.resources)
    || input.resources.ownedProcessResidue !== 0
    || input.resources.tempResidue !== 0
    || input.resources.profileResidue !== 0
    || !Array.isArray(input.resources.ports)
    || input.resources.ports.length === 0
    || input.resources.ports.some((port) => !isOwnedPort(port) || port.closed !== true)
    || !isPlainObject(input.provenance)
    || input.provenance.runId !== input.runId
  ) {
    throw new Error("surface report is not a clean bounded no-skip pass");
  }
  return {
    ...input,
    result: "pass",
    schemaVersion: TASK_048_REPORT_SCHEMA
  };
}

export function aggregateSurfacePass3({
  inputHashEnd,
  inputHashStart,
  reports,
  source
}) {
  const reasons = [];
  if (
    !isPlainObject(source)
    || source.startHead !== source.endHead
    || !isGitSha(source.startHead)
  ) {
    reasons.push("source-drift");
  }
  if (
    inputHashStart !== inputHashEnd
    || !isSha256(inputHashStart)
  ) {
    reasons.push("input-drift");
  }
  const surfaces = {};
  for (const surface of [...SURFACES].sort()) {
    const selected = Array.isArray(reports)
      ? reports.filter((report) =>
        isPlainObject(report)
        && report.surface === surface
        && report.result === "pass"
        && report.schemaVersion === TASK_048_REPORT_SCHEMA
        && isValidProjectedReport(report)
      )
      : [];
    surfaces[surface] = { passed: selected.length, required: 3 };
    if (selected.length !== 3) reasons.push(`${surface}-pass-count`);
    const trials = selected.map((report) => report.trial).sort((left, right) => left - right);
    if (trials.join(",") !== "1,2,3") reasons.push(`${surface}-trial-sequence`);
    if (new Set(selected.map((report) => report.runId)).size !== selected.length) {
      reasons.push(`${surface}-duplicate-run`);
    }
  }
  if (!apiWebProvenanceMatches(reports)) reasons.push("api-web-shared-provenance");
  return {
    reasons,
    result: reasons.length === 0 ? "pass" : "fail",
    surfaces
  };
}

function isValidProjectedReport(report) {
  try {
    projectCleanProcessReport(report);
    return true;
  } catch {
    return false;
  }
}

function parseJsonLineByType(output, type) {
  for (const line of output.split("\n").toReversed()) {
    if (!line.includes(`"type":"${type}"`)) continue;
    try {
      const value = JSON.parse(line);
      if (isPlainObject(value) && value.type === type) return value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parsePrefixedJson(output, prefix) {
  for (const line of output.split("\n").toReversed()) {
    if (!line.startsWith(prefix)) continue;
    try {
      return JSON.parse(line.slice(prefix.length));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isExactPlaywrightProjection(value, expectedTestCount) {
  return isPlainObject(value)
    && value.expected === expectedTestCount
    && value.skipped === 0
    && value.unexpected === 0
    && value.flaky === 0
    && isNonNegativeFinite(value.durationMs);
}

function isBrowserReceipt(value) {
  return isPlainObject(value)
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && Number.isSafeInteger(value.processGroupId)
    && value.processGroupId > 0
    && typeof value.launchId === "string"
    && value.launchId.length > 0
    && typeof value.userDataDir === "string"
    && value.userDataDir.length > 0;
}

function loopbackPort(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && Number.isSafeInteger(port)
      && port >= 1
      && port <= 65_535
      ? port
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessGroupReceipt(value) {
  return isPlainObject(value)
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && Number.isSafeInteger(value.processGroupId)
    && value.processGroupId > 0
    && typeof value.osStartedAt === "string"
    && value.osStartedAt.length > 0;
}

function isOwnedPort(value) {
  return isPlainObject(value)
    && typeof value.name === "string"
    && value.name.length > 0
    && Number.isSafeInteger(value.port)
    && value.port >= 1
    && value.port <= 65_535;
}

function isNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function apiWebProvenanceMatches(reports) {
  if (!Array.isArray(reports)) return false;
  for (let trial = 1; trial <= 3; trial += 1) {
    const api = reports.find((report) => report?.surface === "api" && report.trial === trial);
    const web = reports.find((report) => report?.surface === "web" && report.trial === trial);
    if (
      !isPlainObject(api)
      || !isPlainObject(web)
      || api.runId !== web.runId
      || !isPlainObject(api.provenance)
      || !isPlainObject(web.provenance)
      || api.provenance.kind !== "personal-agent-e2e"
      || web.provenance.kind !== "personal-agent-e2e"
      || api.provenance.runId !== api.runId
      || web.provenance.runId !== web.runId
      || JSON.stringify(api.provenance.sharedSurfaces) !== JSON.stringify(["api", "web"])
      || JSON.stringify(web.provenance.sharedSurfaces) !== JSON.stringify(["api", "web"])
    ) {
      return false;
    }
  }
  return true;
}

function isGitSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isInstant(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
