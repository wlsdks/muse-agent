#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function main() {
  const args = process.argv.slice(2);
  const reactorRoot = readOption(args, "--reactor") ?? process.env.REACTOR_SOURCE_DIR;
  const museRoot = readOption(args, "--muse") ?? process.cwd();
  const json = args.includes("--json");

  if (!reactorRoot) {
    console.error("Usage: REACTOR_SOURCE_DIR=/path/to/reactor pnpm verify:reactor-db");
    console.error("   or: node scripts/verify-reactor-db-parity.mjs --reactor /path/to/reactor");
    process.exit(2);
  }

  const resolvedReactorRoot = path.resolve(reactorRoot);
  const resolvedMuseRoot = path.resolve(museRoot);

  if (!fs.existsSync(path.join(resolvedReactorRoot, "settings.gradle.kts"))) {
    console.error(`Reactor source directory is invalid: ${reactorRoot}`);
    process.exit(2);
  }

  if (!fs.existsSync(path.join(resolvedMuseRoot, "packages/db/src/migrations.ts"))) {
    console.error(`Muse source directory is invalid: ${museRoot}`);
    process.exit(2);
  }

  const report = buildDbParityReport(resolvedReactorRoot, resolvedMuseRoot);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, resolvedReactorRoot, resolvedMuseRoot);
  }

  if (report.missingReactorTables.length > 0) {
    process.exit(1);
  }
}

export function buildDbParityReport(reactorRoot, museRoot) {
  const reactorFiles = reactorMigrationFiles(reactorRoot);
  const museFiles = [path.join(museRoot, "packages/db/src/migrations.ts")];
  const reactorSchema = extractSqlSchema(reactorFiles);
  const museSchema = extractSqlSchema(museFiles);
  const museTables = new Set(museSchema.tables.map((table) => table.name));
  const missingReactorTables = reactorSchema.tables
    .filter((table) => !museTables.has(table.name))
    .map((table) => ({
      ...table,
      family: tableFamily(table.name)
    }));

  return {
    missingByFamily: countBy(missingReactorTables, "family"),
    missingReactorTables,
    muse: {
      migrationFiles: museFiles.length,
      tableCount: museSchema.tables.length,
      tables: museSchema.tables.map((table) => table.name)
    },
    reactor: {
      migrationFiles: reactorFiles.length,
      tableCount: reactorSchema.tables.length,
      tables: reactorSchema.tables.map((table) => table.name)
    }
  };
}

export function extractSqlSchema(files) {
  const tableByName = new Map();

  for (const file of files) {
    const source = stripSqlComments(fs.readFileSync(file, "utf8"));
    const createTablePattern =
      /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`]+)\b/giu;
    let match;

    while ((match = createTablePattern.exec(source)) !== null) {
      const name = normalizeTableName(match[1]);

      if (!name || tableByName.has(name)) {
        continue;
      }

      tableByName.set(name, {
        file,
        line: lineOf(source, match.index),
        name
      });
    }
  }

  return {
    tables: [...tableByName.values()].sort((left, right) => left.name.localeCompare(right.name))
  };
}

function reactorMigrationFiles(root) {
  return [
    path.join(root, "modules/persistence-schema/src/main/resources/db/migration"),
    path.join(root, "modules/admin/src/main/resources/db/admin-migration")
  ]
    .filter((directory) => fs.existsSync(directory))
    .flatMap((directory) => walk(directory, ".sql"))
    .sort(compareMigrationPaths);
}

function printReport(report, reactorRoot, museRoot) {
  console.log(`Reactor DB migration files: ${report.reactor.migrationFiles}`);
  console.log(`Muse DB migration files: ${report.muse.migrationFiles}`);
  console.log(`Reactor tables: ${report.reactor.tableCount}`);
  console.log(`Muse tables: ${report.muse.tableCount}`);
  console.log(`Missing Reactor tables in Muse: ${report.missingReactorTables.length}`);

  if (report.missingReactorTables.length === 0) {
    return;
  }

  console.log("\nMissing tables by family:");

  for (const [family, count] of Object.entries(report.missingByFamily).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    console.log(`${family}: ${count}`);
  }

  console.log("\nMissing tables:");

  for (const table of report.missingReactorTables) {
    console.log(`${table.name} [${table.family}] :: ${path.relative(reactorRoot, table.file)}:${table.line}`);
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function isMainModule() {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}

function walk(directory, extension) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    const target = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...walk(target, extension));
      continue;
    }

    if (entry.isFile() && target.endsWith(extension)) {
      paths.push(target);
    }
  }

  return paths;
}

function stripSqlComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

function normalizeTableName(raw) {
  const cleaned = raw.replace(/["`]/g, "").toLowerCase();
  const parts = cleaned.split(".");
  const name = parts.at(-1) ?? "";

  if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
    return undefined;
  }

  return name;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function compareMigrationPaths(left, right) {
  return migrationSortKey(left).localeCompare(migrationSortKey(right), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function migrationSortKey(file) {
  return path.basename(file).replace(/^V(\d+)__/u, (_, version) => `${version.padStart(6, "0")}__`);
}

function tableFamily(tableName) {
  for (const [family, patterns] of Object.entries(tableFamilyPatterns)) {
    if (patterns.some((pattern) => pattern.test(tableName))) {
      return family;
    }
  }

  return "other";
}

const tableFamilyPatterns = {
  "admin/audit/metrics": [
    /^admin_/u,
    /^alert_/u,
    /^metric_/u,
    /^slo_/u,
    /^tenants?$/u,
    /^model_pricing$/u,
    /^tenant_/u
  ],
  "agent/eval/run-log": [/^agent_eval_/u, /^agent_run_logs$/u, /^debug_/u],
  "auth/users": [/^users$/u, /^user_identities$/u, /^auth_/u, /^token_/u],
  "feedback": [/^feedback/u],
  "guard/policy": [/guard/u, /^tool_policy$/u],
  "memory/context": [/memor/u, /summar/u, /^conversation_/u, /^session_tags$/u],
  "mcp": [/^mcp_/u],
  "prompt/intent/persona": [/^experiments$/u, /^experiment_/u, /^prompt_/u, /^personas?$/u, /^intent_/u, /^trials$/u],
  "rag/documents": [/^rag_/u, /^documents?$/u],
  "scheduler": [/^scheduled_/u],
  "slack/integrations": [/^slack_/u, /^channel_faq/u]
};

function countBy(items, key) {
  const counts = {};

  for (const item of items) {
    const value = item[key];
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

if (isMainModule()) {
  main();
}
