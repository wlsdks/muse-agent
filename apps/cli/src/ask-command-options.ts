/**
 * `muse ask` command surface — the `.option()` declaration chain, lifted out
 * of the commands-ask god-file. Pure Commander wiring: no handler logic here,
 * just the flags and their help text (byte-identical to what shipped inline).
 */

import type { Command } from "commander";

import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";

export interface AskOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly image?: string;
  readonly autoImage?: boolean;
  readonly extract?: string;
  readonly toCalendar?: boolean;
  readonly auto?: boolean;
  readonly apply?: boolean;
  readonly top?: string;
  readonly embedModel?: string;
  readonly autoReindex?: boolean;
  readonly tasks?: boolean;
  readonly calendar?: boolean;
  readonly calendarDays?: string;
  readonly reminders?: boolean;
  readonly contacts?: boolean;
  readonly actions?: boolean;
  readonly shell?: boolean;
  readonly git?: boolean;
  readonly file?: string;
  readonly url?: string;
  readonly clipboard?: boolean;
  readonly scope?: string;
  readonly json?: boolean;
  readonly withTools?: boolean;
  readonly actuators?: boolean;
  readonly tiered?: boolean;
  readonly connect?: boolean;
  readonly repair?: boolean;
  readonly bestOf?: string;
  readonly why?: boolean;
  readonly verifyClaims?: boolean;
  /**
   * Clamps the answer to notes + local-memory grounding only.
   * Disables native web_search on every provider path and, when
   * `--with-tools` is also set, allowlists the agent runtime to
   * muse.notes / muse.notes-multi / muse.context only.
   */
  readonly notesOnly?: boolean;
}

/** Wires the `muse ask` argument, help text, and every `.option()` flag onto
 *  `command` (already created via `program.command("ask")`). Pure Commander
 *  declaration — the `.action()` handler is registered by the caller. */
export function applyAskOptions(command: Command): Command {
  return command
    .description("Ask a question with your notes as context — RAG-grounded one-shot via local Qwen. Reads piped stdin too: `cat doc.md | muse ask 'summarize this'`")
    .argument("[query...]", "Free-text question (omit to read entire query from stdin)")
    .addHelpText("after", `
Examples:
  $ muse ask "what did I decide about pricing?"      # grounded one-shot from your notes
  $ muse ask --scope work "who owns the roadmap?"    # ground only on the work/ folder
  $ muse ask --why "when is the launch?"             # show WHY an answer was refused/flagged
  $ muse ask --image receipt.jpg --auto              # SEE an image and draft the matching action`)
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .option("--model <tag>", "Chat model override")
    .option("--top <k>", "Top-K notes chunks to inject as context (default 3)", "3")
    .option("--embed-model <tag>", "Embedding model (must match the index)", DEFAULT_EMBED_MODEL)
    .option(
      "--no-auto-reindex",
      "Skip the auto-stale check before search (default: reindex incrementally when a note's mtime is newer than the index)"
    )
    .option(
      "--no-tasks",
      "Skip injecting open tasks as grounding context (default: include open tasks alongside notes so 'what should I focus on?' answers correctly)"
    )
    .option(
      "--no-calendar",
      "Skip injecting upcoming calendar events as grounding context (default: include events from the configured providers)"
    )
    .option(
      "--calendar-days <n>",
      "Window (in days from now) to pull calendar events into context (default 7)",
      "7"
    )
    .option(
      "--no-reminders",
      "Skip injecting pending reminders as grounding context (default: include pending reminders sorted by due date)"
    )
    .option(
      "--no-contacts",
      "Skip injecting matching contacts as grounding context (default: include contacts whose name/alias/email matches the question)"
    )
    .option(
      "--no-actions",
      "Skip injecting matching action-log entries (default: include what Muse has done on your behalf so 'did you send that?' / 'what have you done?' answer from the real log)"
    )
    .option(
      "--shell",
      "OPT-IN: also ground on matching commands from your shell history (secret-redacted, local-only; default OFF because history is sensitive). Set $MUSE_SHELL_HISTORY_FILE / $HISTFILE to override the source."
    )
    .option(
      "--git",
      "OPT-IN: also ground on your recent git commits in the current repo (read from .git/logs/HEAD, local-only). Answers 'what did I work on?' / 'what was that commit?'. Set $MUSE_GIT_REFLOG_FILE to override the source."
    )
    .option(
      "--file <path>",
      "Ground this answer on a specific file WITHOUT ingesting it into your notes corpus (read-only). The answer cites it as [from <path>]; an off-topic question still honestly refuses."
    )
    .option(
      "--url <url>",
      "Ground this answer on a public web page's readable text WITHOUT ingesting it (read-only fetch). The answer cites it as [from <host>]; an off-topic question still honestly refuses."
    )
    .option(
      "--clipboard",
      "Ground this answer on whatever text you just copied to your clipboard (read-only, local). The answer cites it as [from clipboard]; an off-topic question still honestly refuses. Great for 'I copied this — what does it mean?' without saving a file."
    )
    .option(
      "--scope <folder>",
      "Ground only on notes under this top-level folder, e.g. --scope work — grounds the answer in just that collection instead of the whole corpus (less cross-domain noise). An unknown/empty folder grounds on nothing (honest refusal)."
    )
    .option(
      "--json",
      "Emit a single JSON object on stdout with {query, model, answer, grounded:{...}} (suppresses streaming)"
    )
    .option(
      "--with-tools",
      "Run through the agent runtime so the model can call MCP tools (muse.search, muse.notes.*, muse.tasks.*, etc.). Default off — the chat-only fast path streams ~2x faster but can't fetch fresh web data."
    )
    .option(
      "--actuators",
      "With --with-tools, expose the gated state-changing actuators (email_send, web_action, home_action) so the conversation can trigger them. Each action shows the exact draft and fires only after you confirm. Off by default; providers resolve from env (MUSE_GMAIL_TOKEN, MUSE_HOMEASSISTANT_URL/TOKEN)."
    )
    .option(
      "--notes-only",
      "Clamp grounding to local notes + memory only — disables native web_search on every provider path and, when combined with --with-tools, allowlists the agent runtime to muse.notes / muse.notes-multi / muse.context only."
    )
    .option(
      "--connect",
      "After the answer, surface a '💡 Related in your brain' footer of the strongest related notes / past sessions (second-brain connection, same as `muse today --connect`). Off by default; ignored with --json."
    )
    .option(
      "--tiered",
      "Route this ask to a fast or high-capability model by classifying the question (lookups → fast, reasoning → heavy; defaults to heavy when unsure). Tier models come from MUSE_FAST_MODEL / MUSE_HEAVY_MODEL (each defaults to the configured model). An explicit --model overrides tiering. Off by default."
    )
    .option(
      "--repair",
      "When an answer fails the grounding check, attempt ONE local rewrite constrained to your retrieved notes and show it as a 'Corrected from your notes' offer — but ONLY if the rewrite then re-verifies grounded (else the honest refusal stands; a fix is never fabricated). Off by default; spends one extra local inference."
    )
    .option(
      "--best-of <n>",
      "When an answer fails the grounding check, redraw up to n-1 fresh drafts and keep the best one the deterministic verifier grounds (confirmed by the full gate before it replaces the answer; no survivor = the honest warning stands). Raises the answered rate at the same fabrication=0. 2-5; off by default; spends up to n-1 extra local inferences. Chat-only path (--json/--image/--with-tools unaffected)."
    )
    .option(
      "--why",
      "When Muse refuses or flags an answer, show WHY — which grounding criterion fell short (confidence / coverage / answerability / citation) and the measured value vs its threshold (e.g. 'best match 0.42, I need 0.55'), so you can rephrase, reindex, or add a note. Silent on a confident, grounded answer."
    )
    .option(
      "--verify-claims",
      "Per-claim grounding (Self-RAG ISSUP): after a GROUNDED answer, re-check EACH atomic claim against your notes and surface only the trustworthy subset — so a single fabricated clause in an otherwise-grounded answer ('Mina owns pricing AND the budget was 2M') is flagged 'I'm not sure about …' instead of riding through. Opt-in, fail-open (a check error keeps the claim), never turns a good answer into a refusal; spends one extra local inference per claim."
    )
    .option(
      "--image <path>",
      "Attach a local image (PNG/JPEG/GIF/WebP/HEIC) for the model to SEE — runs locally on the multimodal default (gemma4). e.g. `muse ask --image receipt.jpg '이 영수증 정리해줘'`."
    )
    .option(
      "--auto-image",
      "Auto-attach local image paths mentioned in your message (path-safe + existing files only) so the model SEES them — no explicit --image needed. e.g. `muse ask --auto-image '~/Pictures/receipt.jpg 정리해줘'`."
    )
    .option(
      "--extract <fields>",
      "With --image: extract structured data for the comma-separated fields and print JSON (grounded — an unreadable field is omitted, never invented). e.g. `muse ask --image receipt.jpg --extract 'merchant,total,date'`."
    )
    .option(
      "--to-calendar",
      "With --image: extract a calendar event from the image and DRAFT it (title/startsAt/location/notes). Draft-first — prints the proposed event; re-run with --apply to actually create it. e.g. `muse ask --image flyer.jpg --to-calendar`."
    )
    .option(
      "--auto",
      "With --image: AUTO-detect the image kind (event / receipt / contact) and draft the matching action — calendar event, expense note, or new contact. Draft-first; re-run with --apply to perform it. e.g. `muse ask --image photo.jpg --auto`."
    )
    .option(
      "--apply",
      "With --to-calendar: actually create the extracted event (default is draft-only)."
    );
}
