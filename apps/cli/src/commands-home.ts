/**
 * `muse home call` — opt-in Home Assistant smart-home control. Every
 * service call is confirmation-gated (`outbound-safety.md`): the exact
 * action is shown and only fires on explicit confirm. Opt-in via
 * `MUSE_HOMEASSISTANT_URL` + `MUSE_HOMEASSISTANT_TOKEN`. Not for
 * payments / money movement (out of scope).
 */

import { resolveActionLogFile, resolveHomeAssistantEnvironment, type MuseEnvironment } from "@muse/autoconfigure";
import { listHomeAssistantStates, performHomeActionWithApproval, readHomeAssistantState, type WebActionApprovalGate } from "@muse/domain-tools";
import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface CallOptions {
  readonly entity?: string;
  readonly data?: string;
  readonly user?: string;
}

export interface HomeCommandDeps {
  readonly approvalGate?: WebActionApprovalGate;
  readonly fetchImpl?: typeof fetch;
  readonly actionLogFile?: string;
  readonly baseUrl?: string;
  readonly token?: string;
  /** Bounded test/composition environment seam; explicit endpoint deps never bypass it. */
  readonly env?: MuseEnvironment;
  /** A frozen posture may add strictness but ambient process strictness still wins. */
  readonly localOnlyOverride?: boolean;
}

function resolveHomeCommandEnvironment(deps: HomeCommandDeps) {
  const source = deps.env ?? process.env;
  // Deliberately use accessors instead of a spread/merge. The resolver reads
  // local-only then URL before token; a blocked remote URL therefore never
  // invokes the source token getter, even when explicit URL/token deps exist.
  const env: MuseEnvironment = Object.create(null);
  Object.defineProperties(env, {
    MUSE_HOMEASSISTANT_TOKEN: {
      configurable: true,
      enumerable: true,
      get: () => deps.token ?? source.MUSE_HOMEASSISTANT_TOKEN
    },
    MUSE_HOMEASSISTANT_URL: {
      configurable: true,
      enumerable: true,
      get: () => deps.baseUrl ?? source.MUSE_HOMEASSISTANT_URL
    },
    MUSE_LOCAL_ONLY: {
      configurable: true,
      enumerable: true,
      get: () => source.MUSE_LOCAL_ONLY
    }
  });
  return resolveHomeAssistantEnvironment(env, {
    ...(deps.localOnlyOverride === undefined ? {} : { localOnlyOverride: deps.localOnlyOverride })
  });
}

function reportMissingHomeConnection(io: ProgramIO, status: ReturnType<typeof resolveHomeCommandEnvironment>): void {
  if (status.status === "blocked") {
    io.stderr(`muse home: ${status.reason}.\n`);
    return;
  }
  io.stderr("muse home: set MUSE_HOMEASSISTANT_URL and MUSE_HOMEASSISTANT_TOKEN (a Home Assistant long-lived access token).\n");
}

export function registerHomeCommands(program: Command, io: ProgramIO, deps: HomeCommandDeps = {}): void {
  const home = program.command("home").description("Smart-home control via Home Assistant (opt-in, confirmation-gated)");

  home
    .command("call")
    .description("Call a Home Assistant service (e.g. light.turn_off), only after you confirm")
    .argument("<domain.service>", "Service id, e.g. 'light.turn_off'")
    .option("--entity <id>", "Target entity_id, e.g. 'light.living_room'")
    .option("--data <json>", "Extra service data as JSON")
    .option("--user <id>", "User identity for the action log", "stark")
    .action(async (domainService: string, options: CallOptions) => {
      const homeAssistant = resolveHomeCommandEnvironment(deps);
      if (homeAssistant.status !== "configured") {
        reportMissingHomeConnection(io, homeAssistant);
        process.exitCode = 1;
        return;
      }
      const dot = domainService.indexOf(".");
      if (dot <= 0 || dot === domainService.length - 1) {
        io.stderr(`muse home: service must be '<domain>.<service>' (e.g. light.turn_off), got '${domainService}'\n`);
        process.exitCode = 1;
        return;
      }
      let data: Record<string, unknown> | undefined;
      if (options.data) {
        try {
          data = JSON.parse(options.data) as Record<string, unknown>;
        } catch {
          io.stderr("muse home: --data must be valid JSON\n");
          process.exitCode = 1;
          return;
        }
      }
      const gate: WebActionApprovalGate = deps.approvalGate ?? ((action) => {
        io.stdout(`\n${action.summary}\n${action.request.method ?? "POST"} ${action.request.url}\n${action.request.body ? `${action.request.body}\n` : ""}\n`);
        return confirm({ message: "Perform this smart-home action?" }).then((answer) =>
          isCancel(answer) || answer !== true
            ? { approved: false, reason: "user did not confirm" }
            : { approved: true });
      });

      const outcome = await performHomeActionWithApproval({
        actionLogFile: deps.actionLogFile ?? resolveActionLogFile(deps.env ?? process.env),
        approvalGate: gate,
        baseUrl: homeAssistant.baseUrl,
        domain: domainService.slice(0, dot),
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
        localOnly: homeAssistant.localOnly,
        service: domainService.slice(dot + 1),
        token: homeAssistant.token,
        userId: options.user ?? "stark",
        ...(options.entity ? { entityId: options.entity } : {}),
        ...(data ? { data } : {})
      });

      if (outcome.performed) {
        io.stdout(`Done (HTTP ${outcome.status.toString()}).\n`);
        return;
      }
      io.stderr(`Not performed (${outcome.reason}): ${outcome.detail}\n`);
      process.exitCode = 1;
    });

  home
    .command("state")
    .description("Read a Home Assistant entity's current state (read-only, e.g. is the front door locked)")
    .argument("<entity>", "Target entity_id, e.g. 'lock.front_door'")
    .action(async (entityId: string) => {
      const homeAssistant = resolveHomeCommandEnvironment(deps);
      if (homeAssistant.status !== "configured") {
        reportMissingHomeConnection(io, homeAssistant);
        process.exitCode = 1;
        return;
      }
      const state = await readHomeAssistantState({
        baseUrl: homeAssistant.baseUrl,
        entityId,
        localOnly: homeAssistant.localOnly,
        token: homeAssistant.token,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
      });
      if (state === undefined) {
        io.stderr(`muse home: no state for '${entityId}' (unknown entity or Home Assistant unreachable).\n`);
        process.exitCode = 1;
        return;
      }
      const friendly = typeof state.attributes["friendly_name"] === "string" ? ` (${state.attributes["friendly_name"] as string})` : "";
      io.stdout(`${state.entityId}${friendly}: ${state.state}\n`);
    });

  home
    .command("entities")
    .description("List Home Assistant entities (discover device ids to read/control), optionally filtered by domain and/or state")
    .option("--domain <domain>", "Filter to one device type, e.g. 'light' / 'lock' / 'sensor'")
    .option("--state <state>", "Only entities in this state (case-insensitive), e.g. 'on' / 'unlocked' / 'open' — 'what's left on?'")
    .action(async (options: { domain?: string; state?: string }) => {
      const homeAssistant = resolveHomeCommandEnvironment(deps);
      if (homeAssistant.status !== "configured") {
        reportMissingHomeConnection(io, homeAssistant);
        process.exitCode = 1;
        return;
      }
      const all = await listHomeAssistantStates({
        baseUrl: homeAssistant.baseUrl,
        localOnly: homeAssistant.localOnly,
        token: homeAssistant.token,
        ...(options.domain ? { domain: options.domain } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
      });
      const stateFilter = options.state?.trim().toLowerCase();
      const entities = stateFilter && stateFilter.length > 0
        ? all.filter((entity) => entity.state.toLowerCase() === stateFilter)
        : all;
      if (entities.length === 0) {
        const what = [options.domain ? `domain '${options.domain}'` : "", stateFilter ? `state '${stateFilter}'` : ""].filter((s) => s.length > 0).join(" + ");
        io.stdout(`No entities found${what ? ` for ${what}` : ""} (or Home Assistant unreachable).\n`);
        return;
      }
      for (const entity of entities) {
        io.stdout(`${entity.entityId}: ${entity.state}\n`);
      }
    });
}
