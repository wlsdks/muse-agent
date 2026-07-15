import { readFile } from "node:fs/promises";

import { type KnowledgeMatch } from "@muse/agent-core";
import { demoteStaleHits } from "@muse/recall";
import { isRecord } from "@muse/shared";

import { defaultNotesIndexFile, searchRecall, type RecallHit } from "./commands-recall.js";
import { DEFAULT_EMBED_MODEL, resolveIndexModel } from "./embed-model-default.js";
import { withBestEffort } from "./async-promises.js";

// Per-turn grounding for the conversational surface (`muse chat`).
//
// The problem this closes: unlike `muse ask` — which pre-retrieves the
// user's notes BEFORE generating — plain chat sent the model only the
// persona + the current date, so a factual question about the user's OWN
// data ("what's the office VPN MTU?") was answered from the model's general
// knowledge. With a note saying 1380, chat confabulated "usually 1500
// bytes" — a fabrication-rate-=0 violation on the primary surface. The fix
// is retrieval-augmented chat: embed the turn, pull the most relevant note
// chunks, and inject them as an AUTHORITATIVE block so the answer is cited
// from the user's own data instead of invented.
//
// Deterministic where it counts: the retrieval + threshold are code (the
// small local Qwen never decides whether to ground), so the only
// model-dependent step is "use the passages you were handed", which the
// fact-framed wording below makes reliable on qwen3:8b.

// A hit must clear this cosine to be injected as authoritative context.
// Below it, nomic-embed similarities are topical noise — an off-corpus
// question would otherwise drag in loosely-related notes and the model
// would dutifully "answer" from an irrelevant snippet. Gating here keeps
// the refusal floor intact: nothing relevant ⇒ inject nothing ⇒ the
// persona's "say you don't know" line governs.
export const CHAT_GROUNDING_MIN_SCORE = 0.5;

// The floor is EMBEDDER-SPECIFIC: each embedder produces a different cosine scale.
// CHAT_GROUNDING_MIN_SCORE (0.5) was calibrated on nomic-embed-text, but the
// shipped default is nomic-embed-text-v2-moe, whose compressed scale tops genuine
// matches ~0.42–0.46 — so a 0.5 floor filters OUT real hits and the chat surface
// over-abstains. The v2-moe floor (0.45) is CONFORMAL-CALIBRATED, not guessed:
// over the 24-answerable / 12-refuse edge corpus (`muse doctor --calibration`)
// genuine hits separate from absents at a clean gap [0.415 max-absent, 0.460
// first-clear-positive], so 0.45 keeps the clearly-genuine hits while still
// filtering every absent (fabrication-safe). nomic STAYS 0.5.
const CHAT_GROUNDING_MIN_SCORE_BY_EMBEDDER: Readonly<Record<string, number>> = {
  "nomic-embed-text": 0.5,
  "nomic-embed-text-v2-moe": 0.45
};

/**
 * The cosine a retrieval hit must clear to be treated as authoritative. Precedence:
 *  1. `MUSE_GROUNDING_MIN_COSINE` — an explicit conformal-calibrated override
 *     (`muse doctor --calibration` emits it).
 *  2. the EMBEDDER-SPECIFIC calibrated floor for the ACTIVE embedder — resolved
 *     from `embedModel`, else `MUSE_RECALL_EMBED_MODEL`, else `DEFAULT_EMBED_MODEL`
 *     (so every call site auto-tracks the shipped default without threading).
 *  3. the conservative `CHAT_GROUNDING_MIN_SCORE` (0.5) for an unknown embedder.
 * Fail-safe: a missing / out-of-range env both fall back to the active embedder's
 * floor (or 0.5), so a bad env can never silently break the gate.
 */
export function resolveGroundingMinScore(env: NodeJS.ProcessEnv = process.env, embedModel?: string): number {
  const raw = Number(env.MUSE_GROUNDING_MIN_COSINE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) {
    return raw;
  }
  const model = embedModel ?? env.MUSE_RECALL_EMBED_MODEL?.trim() ?? DEFAULT_EMBED_MODEL;
  const key = model.trim().replace(/^.*\//u, "").replace(/:.*$/u, "");
  return CHAT_GROUNDING_MIN_SCORE_BY_EMBEDDER[key] ?? CHAT_GROUNDING_MIN_SCORE;
}

// Cap the injected passages so a broad query can't balloon the prompt on a
// small context window; the top few by cosine carry the answer.
export const CHAT_GROUNDING_MAX_HITS = 4;

// Skip retrieval for greetings / fragments too short to embed meaningfully
// ("hi", "ok", "thanks") — they never carry a factual question and the
// embed round-trip would be pure latency.
const MIN_QUERY_CHARS = 4;

/**
 * Format relevant recall hits into an authoritative grounding block, or "" when
 * nothing clears the threshold. The wording is deliberately fact-framed and
 * anti-abstention: in live testing qwen3:8b would otherwise hedge to a generic
 * answer even with the note in context, so the block states plainly that these
 * passages are the source of truth and must be cited, not overridden.
 */
/**
 * A short, user-facing citation source. A note's `ref` is its ABSOLUTE path
 * ("/Users/me/.muse/notes/wifi_passwords/seoul_office.md") — ugly, it leaks the
 * home dir, AND it is so long the local model spent its output budget echoing
 * it and TRUNCATED the answer mid-citation. Strip to the path under the notes
 * dir ("wifi_passwords/seoul_office.md"), else the basename. Non-path refs
 * (conversation, …) pass through untouched.
 */
export function shortCitationRef(ref: string): string {
  const marker = "/notes/";
  const idx = ref.lastIndexOf(marker);
  if (idx >= 0) return ref.slice(idx + marker.length);
  if (ref.includes("/")) return ref.slice(ref.lastIndexOf("/") + 1);
  return ref;
}

export function formatChatGroundingBlock(
  hits: readonly RecallHit[],
  minScore: number = resolveGroundingMinScore()
): string {
  const relevant = hits
    .filter((hit) => hit.score >= minScore)
    .slice(0, CHAT_GROUNDING_MAX_HITS);
  if (relevant.length === 0) return "";
  const lines = relevant.map((hit) => `- ${hit.snippet.trim()} [from ${shortCitationRef(hit.ref)}]`);
  return (
    "\n\nThe following passages are from the user's OWN notes — they are the " +
    "authoritative source for any question about the user's data, plans, or " +
    "facts. When the answer is in them, state it directly and cite " +
    "[from <source>]; do NOT override them with general knowledge or hedge to " +
    "a generic answer.\n" +
    lines.join("\n")
  );
}

/**
 * Retrieve + format the grounding block for one chat turn. Fail-soft to "" on
 * a too-short turn, a missing index, or Ollama being down — so the chat surface
 * degrades to the un-grounded refusal floor, never an error.
 */
export interface ChatGrounding {
  /** Authoritative grounding block for the system prompt (may be ""). */
  readonly block: string;
  /** The retrieved evidence — for the deterministic answer gate below. */
  readonly matches: readonly KnowledgeMatch[];
}

function hitsToMatches(hits: readonly RecallHit[]): KnowledgeMatch[] {
  // searchRecall's `score` IS the absolute cosine, which verifyGrounding's
  // retrieval-confidence grading expects in `cosine`. Propagate the episode
  // trust bit (EP-3): a poisoned-episode hit (trusted:false) makes the chat
  // untrusted-only cue fire instead of laundering it as "your own history".
  return hits.map((hit) => ({ cosine: hit.score, score: hit.score, source: hit.ref, text: hit.snippet, ...(hit.trusted === false ? { trusted: false } : {}) }));
}

/**
 * Retrieve the grounding block AND the raw evidence for one chat turn. The
 * evidence feeds the deterministic `gateChatAnswer` so an un-grounded personal
 * fact can be refused by CODE, not left to a prompt instruction qwen3:8b ignores.
 */
/**
 * Auto-refresh the notes index on a chat turn unless explicitly opted out
 * (`MUSE_CHAT_AUTO_REINDEX=0`). The desktop companion only ever runs `chat`, so
 * this is what lets it answer from a note the user just added.
 */
export function chatAutoReindexEnabled(env: Record<string, string | undefined>): boolean {
  return env.MUSE_CHAT_AUTO_REINDEX !== "0";
}

/**
 * Preserve the embedding model a stale index was built with, so a chat-path
 * refresh never silently re-embeds a custom-model index with the default —
 * except the LEGACY default, which migrates once to the shipped multilingual
 * default (resolveIndexModel) so the upgrade reaches existing users.
 */
export function pickReindexModel(existingModel: string | undefined, requested: string): string {
  return resolveIndexModel(existingModel, requested);
}

/**
 * A chat refresh already re-embeds on a stale CONTENT change; it must ALSO
 * re-embed when the index's stored model no longer resolves to itself — i.e.
 * the legacy→default migration. Without this a chat-only user (the desktop
 * companion never runs `muse ask`, which is the only other reindex trigger)
 * keeps ranking new v2-moe query vectors against a v1 index forever: cross-model
 * cosine noise that floats above the authoritative-score floor. Custom models
 * resolve to themselves, so they are NOT flagged.
 */
export function notesIndexNeedsModelMigration(existingModel: string | undefined, requested: string): boolean {
  return existingModel !== undefined && resolveIndexModel(existingModel, requested) !== existingModel;
}

async function defaultReadIndexModel(indexPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8"));
    if (!isRecord(parsed)) {
      return undefined;
    }
    const model = parsed.model;
    return typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface RefreshStaleNotesIndexDeps {
  readonly isStale?: (notesDir: string, indexPath: string) => Promise<boolean>;
  readonly reindex?: (args: { dir: string; indexPath: string; model: string }) => Promise<unknown>;
  readonly readIndexModel?: (indexPath: string) => Promise<string | undefined>;
}

/**
 * Rebuild the notes index when it is stale by CONTENT *or* by MODEL — targeting
 * the SAME file `searchRecall` reads (`defaultNotesIndexFile`), so a chat refresh
 * can never write where the search won't look. Lazy-imports the heavy notes-rag
 * module so it stays out of the bundled desktop binary's startup graph; deps are
 * injectable for tests (the real reindex needs a running embedder).
 */
export async function refreshStaleNotesIndexForChat(
  env: Record<string, string | undefined>,
  embedModel: string,
  deps: RefreshStaleNotesIndexDeps = {}
): Promise<void> {
  const indexPath = defaultNotesIndexFile();
  const { resolveNotesDir } = await import("@muse/autoconfigure");
  const notesDir = resolveNotesDir(env);
  const existingModel = await (deps.readIndexModel ?? defaultReadIndexModel)(indexPath);
  const modelStale = notesIndexNeedsModelMigration(existingModel, embedModel);
  const isStale = deps.isStale ?? (async (d: string, i: string) => (await import("./commands-notes-rag.js")).isNotesIndexStale(d, i));
  if (!modelStale && !(await isStale(notesDir, indexPath))) return;
  const reindex = deps.reindex ?? (async (a: { dir: string; indexPath: string; model: string }) => (await import("./commands-notes-rag.js")).reindexNotes(a));
  await reindex({ dir: notesDir, indexPath, model: pickReindexModel(existingModel, embedModel) });
}

/**
 * Multi-turn retrieval gap (Rewrite-Retrieve-Read, arXiv:2305.14283): an
 * anaphoric turn ("그거 언제 바뀌었지?") embeds onto the PRONOUN, not the topic,
 * so recall misses the note the conversation is plainly about. Fire only on a
 * short turn that carries an anaphor AND has history to resolve it from — a
 * self-contained question must never pay the extra inference.
 */
export function needsContextualRewrite(message: string, historyLength: number): boolean {
  if (historyLength === 0) return false;
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  return /(그게|그거|그건|그때|거기|아까|방금|걔|이건|저건|그 사람|\bit\b|\bthat\b|\bthen\b|\bthere\b|\bhe\b|\bshe\b|\bthey\b)/iu.test(trimmed);
}

export const QUERY_REWRITE_RESPONSE_FORMAT = {
  properties: { query: { type: "string" } },
  required: ["query"],
  type: "object"
};

export const QUERY_REWRITE_SYSTEM_PROMPT =
  "Rewrite the user's LAST message as ONE self-contained search query by resolving its pronouns/references from the conversation. Keep the user's language. Use ONLY words and facts present in the conversation — never invent new ones. Reply as JSON: {\"query\": \"...\"}.";

export function buildQueryRewritePrompt(
  history: readonly { readonly role: string; readonly content: string }[],
  message: string
): string {
  const recent = history.slice(-4).map((turn) => `${turn.role}: ${turn.content}`);
  return [...recent, `user (LAST message to rewrite): ${message}`].join("\n");
}

/** Fail-open parse: anything but a sane constrained JSON keeps the original query. */
export function parseQueryRewrite(output: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (isRecord(parsed) && "query" in parsed) {
      const query = parsed.query;
      if (typeof query === "string" && query.trim().length > 0 && query.length <= 200) {
        return query.trim();
      }
    }
  } catch {
    // fall through to the original message
  }
  return fallback;
}

export async function retrieveChatGrounding(
  message: string,
  opts: {
    readonly embedModel?: string;
    readonly env?: Record<string, string | undefined>;
    readonly minScore?: number;
    /** Injectable recall (tests force a throw without a live/slow Ollama round-trip). */
    readonly searchRecall?: typeof searchRecall;
  } = {}
): Promise<ChatGrounding> {
  const trimmed = message.trim();
  if (trimmed.length < MIN_QUERY_CHARS) return { block: "", matches: [] };
  const env = opts.env ?? (process.env);
  if (env.MUSE_CHAT_GROUNDING === "0") return { block: "", matches: [] };
  const embedModel = opts.embedModel ?? env.MUSE_RECALL_EMBED_MODEL?.trim() ?? DEFAULT_EMBED_MODEL;
  // Refresh a stale notes index before searching — the courtesy `muse ask`
  // already extends. The desktop companion only ever calls `chat`, so without
  // this a note the user just added is unreachable until they remember to run
  // `muse notes reindex`. Fail-soft: search whatever index exists.
  if (chatAutoReindexEnabled(env)) {
    await withBestEffort(refreshStaleNotesIndexForChat(env, embedModel), undefined);
  }
  try {
    const hits = await (opts.searchRecall ?? searchRecall)({
      query: trimmed,
      source: "all",
      limit: CHAT_GROUNDING_MAX_HITS,
      embedModel,
      env
    });
    // A note explicitly marked superseded ("used to …", "예전에 …") must not
    // outrank its current counterpart in what the model is shown or what the
    // citation gate matches against — demote it below, never drop it.
    const ranked = demoteStaleHits(hits);
    return { block: formatChatGroundingBlock(ranked, opts.minScore ?? resolveGroundingMinScore(env, embedModel)), matches: hitsToMatches(ranked) };
  } catch {
    return { block: "", matches: [] };
  }
}

export async function groundChatTurn(
  message: string,
  opts: {
    readonly embedModel?: string;
    readonly env?: Record<string, string | undefined>;
    readonly minScore?: number;
    /** Injectable recall (tests force a throw without a live/slow Ollama round-trip). */
    readonly searchRecall?: typeof searchRecall;
  } = {}
): Promise<string> {
  return (await retrieveChatGrounding(message, opts)).block;
}

/**
 * Prior conversation turns as authoritative evidence — a fact the user stated
 * earlier THIS session is grounded, so the gate must not refuse to recall it.
 */
export function conversationMatches(
  history: readonly { readonly role: string; readonly content: string }[]
): KnowledgeMatch[] {
  return history
    .filter((turn) => turn.content.trim().length > 0)
    .map((turn) => ({ cosine: 1, score: 1, source: "conversation", text: turn.content }));
}
