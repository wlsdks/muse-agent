/**
 * `GET /api/identity-tagline?lang=ko|en` — one short, personalized, ever-changing
 * subtitle for the web sidebar (replaces the static "AI 지휘자" / "AI Conductor").
 *
 * Cheap and fail-soft BY CONTRACT: it must never 500 the sidebar. Any failure
 * (no store, unreadable state, model error) collapses to a content-free playful
 * pool line with `grounded:false`, and the web keeps the static i18n subtitle as
 * its own instant fallback. fabrication = 0 is enforced in `identity-tagline.ts`.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withBestEffort } from "@muse/shared";


import type { UserMemoryStore } from "@muse/memory";
import type { FastifyInstance } from "fastify";

import {
  applyTaglineModel,
  contentFreePool,
  gatherIdentityFacts,
  selectTagline,
  type TaglineLang,
  type TaglineModelFn
} from "./identity-tagline.js";
import { isRecord, readQueryString } from "./compat-parsers.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server-options.js";

export interface IdentityTaglineRoutesOptions {
  readonly authService: ServerOptions["authService"];
  readonly userMemoryStore?: UserMemoryStore;
  readonly model?: TaglineModelFn;
  readonly defaultUserId?: string;
  /** Override the rotation/recent state file (tests). */
  readonly stateFile?: string;
}

interface TaglineState {
  readonly recent: readonly string[];
  readonly rotation: number;
}

const RECENT_WINDOW = 6;

function resolveStateFile(options: IdentityTaglineRoutesOptions): string {
  return (
    options.stateFile?.trim() ||
    process.env.MUSE_TAGLINE_STATE_FILE?.trim() ||
    join(homedir(), ".muse", "identity-tagline-state.json")
  );
}

async function readState(file: string): Promise<TaglineState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    const safeParsed = isRecord(parsed) ? parsed : {};
    const recent = Array.isArray(safeParsed.recent)
      ? safeParsed.recent.filter((r): r is string => typeof r === "string")
      : [];
    const rotation = typeof safeParsed.rotation === "number" && Number.isFinite(safeParsed.rotation)
      ? Math.trunc(safeParsed.rotation)
      : 0;
    return { recent, rotation };
  } catch {
    return { recent: [], rotation: 0 };
  }
}

async function writeState(file: string, state: TaglineState): Promise<void> {
  try {
    await fs.mkdir(join(file, ".."), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // best-effort: a subtitle must never fail on a state-file write
  }
}

function resolveLang(raw: unknown): TaglineLang {
  return typeof raw === "string" && raw.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function registerIdentityTaglineRoutes(
  server: FastifyInstance,
  options: IdentityTaglineRoutesOptions
): void {
  const stateFile = resolveStateFile(options);

  server.get("/api/identity-tagline", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) {
      return reply;
    }
    const lang = resolveLang(readQueryString(request, "lang"));

    try {
      const userId = readQueryString(request, "userId") || options.defaultUserId || "me";
      const memory = options.userMemoryStore
        ? await withBestEffort(options.userMemoryStore.findByUserId(userId), undefined)
        : undefined;
      const atoms = gatherIdentityFacts(memory);

      const state = await readState(stateFile);
      const plan = selectTagline({ atoms, lang, recent: state.recent, rotation: state.rotation });
      const result = await applyTaglineModel(plan, atoms, lang, options.model);

      await writeState(stateFile, {
        recent: [...state.recent, result.tagline].slice(-RECENT_WINDOW),
        rotation: state.rotation + 1
      });

      return reply.status(200).send({ grounded: result.grounded, tagline: result.tagline });
    } catch {
      const pool = contentFreePool(lang);
      return reply.status(200).send({ grounded: false, tagline: pool[0] ?? "" });
    }
  });
}
