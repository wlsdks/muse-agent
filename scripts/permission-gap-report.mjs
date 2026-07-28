/**
 * Deterministic, read-only inventory for Task 012. It deliberately records
 * only an existing authority class or the literal `unmapped`; it must never
 * infer a class from a route, command, risk, or name prefix.
 *
 * Run after the participating workspace packages have been built:
 *   pnpm report:permission-gaps
 */

import { buildServer } from "../apps/api/src/server.ts";
import { createApiServerOptions } from "../packages/autoconfigure/src/index.ts";
import {
  ACTUATOR_PERMISSION_MATRIX,
  classifyActuatorPermission
} from "../apps/cli/src/actuator-tools.ts";
import {
  COMMAND_STUBS,
  EAGER_COMMAND_NAMES
} from "../apps/cli/src/command-manifest.ts";
import { describeBuiltinLoopbackMcpServers } from "../packages/domain-tools/src/index.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SURFACE_ORDER = ["tool", "cli", "api", "mcp"];
const EXPLICIT_SURFACE_AUTHORITY = new Map([
  ["cli\u0000email send", "external-send"]
]);

export const TASK_LIST_AUTHORITY_PARITY = Object.freeze({
  adapters: Object.freeze([
    Object.freeze({ name: "tasks list", surface: "cli" }),
    Object.freeze({ name: "GET /api/tasks", surface: "api" }),
    Object.freeze({ name: "GET /api/tasks?status={filter}", surface: "web" }),
    Object.freeze({ name: "muse.tasks.list", surface: "mcp" })
  ]),
  // `readTasks` quarantines malformed JSON by renaming the owner store. The
  // permission envelope must therefore expose the recoverable local write,
  // even though the healthy-store path only reads.
  effect: "list-with-corrupt-store-quarantine",
  result: Object.freeze({ approval: "not-required", authorityClass: "local-write" }),
  target: "owner-task-store"
});

/**
 * Resolve one adapter-neutral authority contract. A caller must provide the
 * exact target, effect, surface, and public adapter name; near matches never
 * inherit a permission or approval result.
 *
 * @param {{ readonly target: string; readonly effect: string; readonly surface: string; readonly name: string }} input
 */
export function resolveAuthorityParity(input) {
  if (
    input.target !== TASK_LIST_AUTHORITY_PARITY.target
    || input.effect !== TASK_LIST_AUTHORITY_PARITY.effect
    || !TASK_LIST_AUTHORITY_PARITY.adapters.some(
      (adapter) => adapter.surface === input.surface && adapter.name === input.name
    )
  ) {
    return { approval: "unverified", authorityClass: "unmapped" };
  }
  return TASK_LIST_AUTHORITY_PARITY.result;
}

/** @typedef {"read" | "local-write" | "process" | "network" | "external-send" | "unmapped"} AuthorityClass */
/** @typedef {{ readonly surface: "tool" | "cli" | "api" | "mcp"; readonly name: string; readonly authorityClass: AuthorityClass }} PermissionGapRow */

/**
 * Reuse only exact, reviewed classifications: the advertised actuator matrix
 * plus individually closed public-surface tuples. Every other surface remains
 * `unmapped`; names, route shapes, and coarse risk labels are never heuristics.
 *
 * @param {"tool" | "cli" | "api" | "mcp"} surface
 * @param {string} name
 * @returns {AuthorityClass}
 */
export function classifyPermissionGapAuthority(surface, name) {
  if (surface === "tool") {
    return classifyActuatorPermission(name) ?? "unmapped";
  }
  return EXPLICIT_SURFACE_AUTHORITY.get(`${surface}\u0000${name}`) ?? "unmapped";
}

/** @param {readonly PermissionGapRow[]} rows */
function stableUniqueRows(rows) {
  const unique = new Map();
  for (const row of rows) {
    const key = `${row.surface}\u0000${row.name}`;
    const previous = unique.get(key);
    if (previous && previous.authorityClass !== row.authorityClass) {
      throw new Error(`conflicting authority classes for ${row.surface}:${row.name}`);
    }
    unique.set(key, row);
  }
  return [...unique.values()].sort((left, right) =>
    SURFACE_ORDER.indexOf(left.surface) - SURFACE_ORDER.indexOf(right.surface)
    || left.name.localeCompare(right.name)
  );
}

function defaultReportEnv() {
  const home = join(tmpdir(), "muse-permission-gap-report-readonly");
  return {
    HOME: home,
    MUSE_HOME: join(home, ".muse"),
    MUSE_LOCAL_ONLY: "true",
    MUSE_NOTES_DIR: tmpdir(),
    MUSE_SCHEDULER_CRON_ENABLED: "false",
    MUSE_USER_MEMORY_AUTO_EXTRACT: "false"
  };
}

/**
 * Runtime composition eagerly ensures the configured notes directory exists.
 * The permission report only needs the resulting public tool/route catalogs,
 * so point that composition-only path at an already-existing neutral directory
 * without changing the caller's environment or owner filesystem.
 *
 * @param {Record<string, string | undefined>} env
 */
function readOnlyCompositionEnv(env) {
  const compositionEnv = Object.create(env);
  Object.defineProperty(compositionEnv, "MUSE_NOTES_DIR", {
    enumerable: true,
    value: tmpdir()
  });
  return compositionEnv;
}

/** @param {ReturnType<typeof createApiServerOptions>} serverOptions */
async function apiRows(serverOptions) {
  const server = buildServer({
    ...serverOptions,
    logger: false
  });
  try {
    const response = await server.inject({ method: "GET", url: "/api/openapi.json" });
    if (response.statusCode !== 200) {
      throw new Error(`OpenAPI inventory returned ${response.statusCode}`);
    }
    /** @type {{ readonly paths?: Record<string, Record<string, unknown>> }} */
    const document = JSON.parse(response.body);
    return Object.entries(document.paths ?? {}).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => ({
        authorityClass: "unmapped",
        name: `${method.toUpperCase()} ${path}`,
        surface: "api"
      }))
    );
  } finally {
    await server.close();
  }
}

/** @param {{ readonly env?: Record<string, string | undefined> }} [options] */
export async function createPermissionGapReport(options = {}) {
  const env = options.env ?? defaultReportEnv();
  const serverOptions = createApiServerOptions({
    env: readOnlyCompositionEnv(env),
    localOnlyOverride: true
  });
  /** @type {PermissionGapRow[]} */
  const rows = [
    ...serverOptions.toolCatalogProvider().map((tool) => ({
      authorityClass: classifyPermissionGapAuthority("tool", tool.name),
      name: tool.name,
      surface: "tool"
    })),
    ...EAGER_COMMAND_NAMES.map((name) => ({
      authorityClass: "unmapped",
      name,
      surface: "cli"
    })),
    ...COMMAND_STUBS.flatMap((command) => [{
      authorityClass: classifyPermissionGapAuthority("cli", command.name),
      name: command.name,
      surface: "cli"
    }, ...command.subcommands.map((subcommand) => ({
      authorityClass: classifyPermissionGapAuthority("cli", `${command.name} ${subcommand}`),
      name: `${command.name} ${subcommand}`,
      surface: "cli"
    }))]),
    ...(await apiRows(serverOptions)),
    ...describeBuiltinLoopbackMcpServers().flatMap((server) =>
      server.tools.map((tool) => ({
        authorityClass: "unmapped",
        name: `${server.name}.${tool.name}`,
        surface: "mcp"
      }))
    )
  ];

  // Every key in the existing closed actuator matrix must remain visible even
  // if a controlled local runtime disables that actuator at composition time.
  rows.push(...Object.keys(ACTUATOR_PERMISSION_MATRIX).map((name) => ({
      authorityClass: classifyPermissionGapAuthority("tool", name),
      name,
      surface: "tool"
    })));

  return {
    rows: stableUniqueRows(rows),
    schemaVersion: 1
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  process.stdout.write(`${JSON.stringify(await createPermissionGapReport(), null, 2)}\n`);
}
