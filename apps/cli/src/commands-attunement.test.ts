import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReminders, writeTasks, type PersistedReminder, type PersistedTask } from "@muse/stores";
import { computeContinuityEvaluation, createLocalExactArtifactResolver, prepareContinuityReview, readAttunementState } from "@muse/attunement";
import { CalendarProviderRegistry, encodeCalendarEventReference, type CalendarEvent, type CalendarProvider } from "@muse/calendar";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerAttunementCommands, type AttunementCommandDeps } from "./commands-attunement.js";
import type { McpToolCaller } from "./attunement-mcp-resource.js";

interface Fixture {
  readonly attunementFile: string;
  readonly notesDir: string;
  readonly remindersFile: string;
  readonly taskFile: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "muse-attunement-cli-"));
  const notesDir = join(root, "notes");
  mkdirSync(notesDir);
  return {
    attunementFile: join(root, "attunement.json"),
    notesDir,
    remindersFile: join(root, "reminders.json"),
    taskFile: join(root, "tasks.json")
  };
}

async function run(fixture: Fixture, args: string[], deps?: AttunementCommandDeps): Promise<{ readonly exitCode: number | undefined; readonly stderr: string; readonly stdout: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = {
    MUSE_ATTUNEMENT_FILE: process.env.MUSE_ATTUNEMENT_FILE,
    MUSE_NOTES_DIR: process.env.MUSE_NOTES_DIR,
    MUSE_REMINDERS_FILE: process.env.MUSE_REMINDERS_FILE,
    MUSE_TASKS_FILE: process.env.MUSE_TASKS_FILE
  };
  process.env.MUSE_ATTUNEMENT_FILE = fixture.attunementFile;
  process.env.MUSE_NOTES_DIR = fixture.notesDir;
  process.env.MUSE_REMINDERS_FILE = fixture.remindersFile;
  process.env.MUSE_TASKS_FILE = fixture.taskFile;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerAttunementCommands(program, { stderr: (line: string) => stderr.push(line), stdout: (line: string) => stdout.push(line) }, deps ?? {});
    await program.parseAsync(["node", "muse", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function threadId(output: string): string {
  const id = output.match(/thread_[\w-]+/u)?.[0];
  expect(id).toBeTruthy();
  return id!;
}

const TASK: PersistedTask = {
  createdAt: "2026-07-14T00:00:00.000Z",
  id: "task_8f046e20-cb0b-4c75-82ac-9fc357cfe9b1",
  notes: "Ask Jamie which flowers they prefer.",
  status: "open",
  title: "Send the flower options"
};

const REMINDER: PersistedReminder = {
  createdAt: "2026-07-14T00:00:00.000Z",
  dueAt: "2026-07-18T09:00:00.000Z",
  id: "reminder_cli_dentist",
  status: "pending",
  text: "Bring the referral letter"
};

const CALENDAR_EVENT: CalendarEvent = {
  allDay: false,
  endsAt: new Date("2026-07-20T10:00:00.000Z"),
  id: "event_cli_review",
  location: "Room 4",
  providerId: "work-calendar",
  startsAt: new Date("2026-07-20T09:00:00.000Z"),
  title: "Review roadmap"
};

function calendarRegistry(): CalendarProviderRegistry {
  const provider: CalendarProvider & { resolveExactEvent(locator: { readonly eventId: string; readonly startsAt: string }): Promise<CalendarEvent | undefined> } = {
    createEvent: async () => CALENDAR_EVENT,
    deleteEvent: async () => undefined,
    describe: () => ({ credentials: [], description: "Work calendar", displayName: "Work", id: "work-calendar", local: true }),
    id: "work-calendar",
    listEvents: async () => [CALENDAR_EVENT],
    resolveExactEvent: async (locator) => locator.eventId === CALENDAR_EVENT.id && locator.startsAt === CALENDAR_EVENT.startsAt.toISOString() ? CALENDAR_EVENT : undefined,
    updateEvent: async () => CALENDAR_EVENT
  };
  return new CalendarProviderRegistry([provider]);
}

describe("muse thread / continue — Personal Continuity", () => {
  it("requires an explicit equal life/work kind — there is no hidden default", async () => {
    const f = fixture();
    const missing = await run(f, ["thread", "start", "Plan", "the", "week"]);
    expect(missing.exitCode).toBe(1);

    const life = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const work = await run(f, ["thread", "start", "Prepare", "the", "launch", "--kind", "work"]);
    expect(life.stdout).toContain("Started life thread");
    expect(work.stdout).toContain("Started work thread");
    expect((await run(f, ["thread", "list"])).stdout).toContain("[life]");
    expect((await run(f, ["thread", "list"])).stdout).toContain("[work]");
  });

  it("links canonical local sources, opens a grounded pack, and applies outcome without a model", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    writeFileSync(join(f.notesDir, "birthday.md"), "# Birthday ideas\nJamie likes a small garden dinner.\n", "utf8");
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);

    // Task prefix is accepted at the CLI boundary, but status/pack output uses
    // the canonical full ID persisted by the store.
    expect((await run(f, ["thread", "link", id, "task", TASK.id.slice(0, 13), "--role", "next-step"])).stdout)
      .toContain(TASK.id);
    expect((await run(f, ["thread", "link", id, "note", "birthday.md", "--role", "context"])).stdout)
      .toContain("note:birthday.md");

    const continued = await run(f, ["continue", id]);
    expect(continued.exitCode).toBeUndefined();
    expect(continued.stdout).toContain("Plan a birthday [life]");
    expect(continued.stdout).toContain(`[task:${TASK.id}] Send the flower options`);
    expect(continued.stdout).toContain("Birthday ideas");
    const deliveryId = continued.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(deliveryId).toBeTruthy();

    const beforeInteractions = readFileSync(f.attunementFile, "utf8");
    const interactions = JSON.parse((await run(f, ["thread", "interactions", "--json"])).stdout) as {
      readonly audit: { readonly byThreadKind: { readonly life: { readonly remainingExactInteractions: number } }; readonly status: string };
      readonly digest: { readonly byThreadKind: { readonly life: { readonly totalDeliveries: number } }; readonly overall: { readonly states: { readonly none: { readonly count: number } }; readonly totalDeliveries: number } };
      readonly interactions: readonly { readonly deliveryId: string; readonly interaction: { readonly state: string } }[];
    };
    expect(interactions.digest).toMatchObject({
      byThreadKind: { life: { totalDeliveries: 1 } },
      overall: { states: { none: { count: 1 } }, totalDeliveries: 1 }
    });
    expect(interactions.audit).toMatchObject({
      byThreadKind: { life: { remainingExactInteractions: 10 } },
      status: "collecting"
    });
    expect(interactions.interactions).toContainEqual(expect.objectContaining({
      deliveryId,
      interaction: expect.objectContaining({ state: "none" })
    }));
    expect(readFileSync(f.attunementFile, "utf8")).toBe(beforeInteractions);

    const interactionText = await run(f, ["thread", "interactions"]);
    expect(interactionText.stdout).toContain("Production-authorized interaction coverage");
    expect(interactionText.stdout).toContain("Interaction digest: 1 delivery; exact=0 none=1 unavailable=0");
    expect(interactionText.stdout).toContain("life: 1 delivery; exact=0 none=1 unavailable=0");
    expect(interactionText.stdout).toContain("Interaction audit: collecting");
    expect(interactionText.stdout).toContain("life: exact=0/10 opened UTC dates=0/2");
    expect(interactionText.stdout).toContain("does not certify natural timing, usefulness, or permission");
    expect(interactionText.stdout).toContain("All recorded technical interaction evidence");

    const outcome = await run(f, ["thread", "outcome", deliveryId!, "ignored"]);
    expect(outcome.stdout).toContain("Recorded ignored");
    const next = await run(f, ["thread", "continue", id]);
    expect(next.stdout).toContain("Previous pack: ignored");
  });

  it("links and reviews one exact reminder as read-only context", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    await writeReminders(f.remindersFile, [REMINDER]);
    const reminderBefore = readFileSync(f.remindersFile);
    const deps: AttunementCommandDeps = { now: () => Date.parse("2026-07-19T09:00:00.000Z") };
    const started = await run(f, ["thread", "start", "Prepare", "for", "dentist", "--kind", "life"], deps);
    const id = threadId(started.stdout);

    const linked = await run(f, ["thread", "link", id, "reminder", "reminder_cli_d", "--role", "context"], deps);
    expect(linked.stdout).toContain(`local:reminder:${REMINDER.id}`);
    const rejectedNextStep = await run(f, ["thread", "link", id, "reminder", REMINDER.id, "--role", "next-step"], deps);
    expect(rejectedNextStep.exitCode).toBe(1);
    expect(rejectedNextStep.stderr).toContain("only a local task can be a next-step");

    await run(f, ["thread", "link", id, "task", TASK.id, "--role", "next-step"], deps);
    const continued = await run(f, ["continue", id], deps);
    expect(continued.stdout).toContain(`[reminder:${REMINDER.id}] ${REMINDER.text}`);
    expect(continued.stdout).toContain(`status: pending · overdue: ${REMINDER.dueAt}`);
    expect(await readFileSync(f.remindersFile)).toEqual(reminderBefore);

    const attunementBeforeReview = readFileSync(f.attunementFile);
    const review = await run(f, ["thread", "review", "--json"], deps);
    expect(review.stdout).toContain(`"artifactType": "reminder"`);
    expect(readFileSync(f.attunementFile)).toEqual(attunementBeforeReview);
    expect(readFileSync(f.remindersFile)).toEqual(reminderBefore);
  });

  it("links, resolves, and provider-scoped unlinks one exact calendar occurrence", async () => {
    const f = fixture();
    const deps: AttunementCommandDeps = { calendarRegistry: calendarRegistry(), now: () => Date.parse("2026-07-19T09:00:00.000Z") };
    const id = threadId((await run(f, ["thread", "start", "Review", "roadmap", "--kind", "work"], deps)).stdout);
    const reference = encodeCalendarEventReference(CALENDAR_EVENT);

    const missingProvider = await run(f, ["thread", "link", id, "calendar-event", reference, "--role", "context"], deps);
    expect(missingProvider.exitCode).toBe(1);
    expect(missingProvider.stderr).toContain("requires --provider");

    const linked = await run(f, ["thread", "link", id, "calendar-event", reference, "--provider", "work-calendar", "--role", "context"], deps);
    expect(linked.stdout).toContain(`calendar:work-calendar:calendar-event:${reference}`);
    const continued = await run(f, ["continue", id], deps);
    expect(continued.stdout).toContain(`[calendar-event:${reference}] Review roadmap`);
    expect(continued.stdout).toContain("upcoming: 2026-07-20T09:00:00.000Z");
    expect(continued.stdout).toContain("location: Room 4");

    const unlinked = await run(f, ["thread", "unlink", id, "calendar-event", reference, "--provider", "work-calendar"], deps);
    expect(unlinked.stdout).toContain(`Unlinked calendar-event:${reference}`);
    expect((await readAttunementState(f.attunementFile)).threads[0]?.links).toHaveLength(0);
  });

  it("shows an exact overdue due and safely escaped JSON tags from the linked task", async () => {
    const f = fixture();
    const task: PersistedTask = {
      ...TASK,
      dueAt: "2026-07-16T10:00:00.000Z",
      tags: ["errands", "line\nbreak", "\u001b[31mred"]
    };
    await writeTasks(f.taskFile, [task]);
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", task.id, "--role", "next-step"]);

    const continued = await run(f, ["continue", id], { now: () => Date.parse("2026-07-17T00:00:00.000Z") });
    expect(continued.stdout).toContain("overdue: 2026-07-16T10:00:00.000Z");
    expect(continued.stdout).toContain('tags: ["errands","line\\nbreak","\\u001b[31mred"]');
    expect(continued.stdout).not.toContain("line\nbreak");
    expect(continued.stdout).not.toContain("\u001b[31mred");
  });

  it("captures one Pack clock and treats invalid, equal, and future due values deterministically", async () => {
    const nowMs = Date.parse("2026-07-17T00:00:00.000Z");
    const cases = [
      { dueAt: "not-a-date", expected: undefined },
      { dueAt: "2026-07-17T00:00:00.000Z", expected: "due: 2026-07-17T00:00:00.000Z" },
      { dueAt: "2026-07-18T00:00:00.000Z", expected: "due: 2026-07-18T00:00:00.000Z" }
    ] as const;

    for (const { dueAt, expected } of cases) {
      const f = fixture();
      await writeTasks(f.taskFile, [{ ...TASK, dueAt }]);
      const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
      const id = threadId(started.stdout);
      await run(f, ["thread", "link", id, "task", TASK.id, "--role", "next-step"]);
      let clockReads = 0;
      const continued = await run(f, ["continue", id], { now: () => {
        clockReads += 1;
        return nowMs;
      } });

      expect(clockReads).toBe(1);
      if (expected) {
        expect(continued.stdout).toContain(expected);
        expect(continued.stdout).not.toContain(`overdue: ${dueAt}`);
      } else {
        expect(continued.stdout).not.toContain(dueAt);
      }
    }
  });

  it("keeps due and tags in compact direct Packs and suppresses them when the next step is hidden", async () => {
    const f = fixture();
    const task: PersistedTask = {
      ...TASK,
      dueAt: "2026-07-16T10:00:00.000Z",
      tags: ["birthday"]
    };
    const deps: AttunementCommandDeps = { now: () => Date.parse("2026-07-17T00:00:00.000Z") };
    await writeTasks(f.taskFile, [task]);
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", task.id, "--role", "next-step"]);

    const initial = await run(f, ["continue", id], deps);
    const initialDelivery = initial.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(initialDelivery).toBeTruthy();
    await run(f, ["thread", "outcome", initialDelivery!, "used"]);

    const compact = await run(f, ["continue", id], deps);
    expect(compact.stdout).toContain("overdue: 2026-07-16T10:00:00.000Z");
    expect(compact.stdout).toContain('tags: ["birthday"]');
    const compactDelivery = compact.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(compactDelivery).toBeTruthy();
    await run(f, ["thread", "outcome", compactDelivery!, "rejected"]);

    const hidden = await run(f, ["continue", id], deps);
    expect(hidden.stdout).toContain("Next step: hidden after your previous feedback.");
    expect(hidden.stdout).not.toContain("2026-07-16T10:00:00.000Z");
    expect(hidden.stdout).not.toContain('tags: ["birthday"]');
  });

  it("shows normalized user-authored task notes instead of repeating the title for a contextual next step", async () => {
    const f = fixture();
    const task = {
      ...TASK,
      notes: "  Ask Jamie which flowers they prefer.\nThen send only the matching options.  "
    };
    await writeTasks(f.taskFile, [task]);
    writeFileSync(join(f.notesDir, "birthday-context.md"), "# Birthday context\nKeep the garden dinner small.\n", "utf8");
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", task.id, "--role", "next-step"]);
    await run(f, ["thread", "link", id, "note", "birthday-context.md", "--role", "context"]);

    const initial = await run(f, ["continue", id]);
    expect(initial.stdout).toContain(`Next step: ${task.title} [${task.id}]`);
    const deliveryId = initial.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(deliveryId).toBeTruthy();
    await run(f, ["thread", "outcome", deliveryId!, "adjusted"]);

    const contextual = await run(f, ["continue", id]);
    expect(contextual.stdout).toContain(
      `Next-action notes: Ask Jamie which flowers they prefer. Then send only the matching options. [${task.id}]`
    );
    expect(contextual.stdout.match(/Ask Jamie which flowers they prefer\. Then send only the matching options\./gu)).toHaveLength(1);
    expect(contextual.stdout).toContain("[note:birthday-context.md] birthday-context.md — Birthday context");
    expect(contextual.stdout).not.toContain(`Linked next step: ${task.title}`);
  });

  it("shows the exact local edit command when a contextual next step has only whitespace notes", async () => {
    const f = fixture();
    const task = { ...TASK, notes: " \n\t " };
    await writeTasks(f.taskFile, [task]);
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", task.id, "--role", "next-step"]);

    const initial = await run(f, ["continue", id]);
    const deliveryId = initial.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(deliveryId).toBeTruthy();
    await run(f, ["thread", "outcome", deliveryId!, "adjusted"]);

    const contextual = await run(f, ["continue", id]);
    expect(contextual.stdout).toContain(
      `Next step needs detail: muse tasks edit ${task.id} --notes "<first concrete action>" --local`
    );
    expect(contextual.stdout).not.toContain(`Next step: ${task.title}`);
  });

  it("bounds contextual task notes to 240 code units", async () => {
    const f = fixture();
    const task = { ...TASK, notes: `\n${"A".repeat(245)}\n` };
    await writeTasks(f.taskFile, [task]);
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", task.id, "--role", "next-step"]);

    const initial = await run(f, ["continue", id]);
    const deliveryId = initial.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(deliveryId).toBeTruthy();
    await run(f, ["thread", "outcome", deliveryId!, "adjusted"]);

    const contextual = await run(f, ["continue", id]);
    expect(contextual.stdout.split("\n").find((line) => line.startsWith("Next-action notes:"))).toBe(
      `Next-action notes: ${"A".repeat(240)} [${task.id}]`
    );
  });

  it("keeps a rejected next step hidden in the public CLI", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", TASK.id, "--role", "next-step"]);

    const initial = await run(f, ["continue", id]);
    const deliveryId = initial.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(deliveryId).toBeTruthy();
    await run(f, ["thread", "outcome", deliveryId!, "rejected"]);

    const hidden = await run(f, ["continue", id]);
    expect(hidden.stdout).toContain("Next step: hidden after your previous feedback.");
    expect(hidden.stdout).not.toContain(`Next step: ${TASK.title}`);
  });

  it("an OPEN task linked as context (not next-step) names the gap + the exact fix, not a misleading 'no task linked' (dogfood)", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    const started = await run(f, ["thread", "start", "Ship", "the", "migration", "--kind", "work"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", TASK.id.slice(0, 13), "--role", "context"]);

    const continued = await run(f, ["continue", id]);
    // The old copy claimed "no open local task is linked" even though one is —
    // the accurate message names the LINKED task and the role change that sets it.
    // Assert the full next-step line (the task id also appears in the evidence
    // list, so a substring-only check wouldn't guard the contextTask branch).
    expect(continued.stdout).not.toContain("no open local task is linked");
    expect(continued.stdout).toContain(`Next step: none set — task ${TASK.id} is linked as context; re-link it with \`--role next-step\``);
  });

  it("fails closed rather than choosing a thread or escaping the notes vault", async () => {
    const f = fixture();
    const started = await run(f, ["thread", "start", "Keep", "a", "secret", "--kind", "life"]);
    const id = threadId(started.stdout);
    expect((await run(f, ["continue"])).stderr).toContain("thread id is required outside an interactive terminal");
    expect((await run(f, ["thread", "link", id, "note", "../secret.md", "--role", "context"])).stderr).toContain("must not contain '..'");

    const outside = join(tmpdir(), `muse-attunement-outside-${Date.now().toString()}.md`);
    writeFileSync(outside, "not in this vault", "utf8");
    symlinkSync(outside, join(f.notesDir, "escaped.md"));
    const escaped = await run(f, ["thread", "link", id, "note", "escaped.md", "--role", "context"]);
    expect(escaped.stderr).toContain("escapes the local notes vault");
  });
});

const CANNED_ISSUE = { body: "Concurrent renders drop updates.", number: 7, state: "open", title: "Fix the render loop" };

function githubFakeCaller(reachable = true): McpToolCaller {
  return async (server, tool, args) => {
    if (!reachable) throw new Error("ECONNREFUSED");
    if (server === "github" && tool === "get_issue" && args["owner"] === "facebook" && args["repo"] === "react" && args["issue_number"] === 7) {
      return CANNED_ISSUE;
    }
    throw new Error("resource not found");
  };
}

describe("muse thread — external MCP resource links", () => {
  it("links a known github resource with the canonical id and shows it as evidence; rejects unknown + next-step", async () => {
    const f = fixture();
    const deps: AttunementCommandDeps = { mcpResourceCaller: githubFakeCaller() };
    const started = await run(f, ["thread", "start", "Ship", "the", "adapter", "--kind", "work"], deps);
    const id = threadId(started.stdout);

    const linked = await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/7", "--role", "context"], deps);
    expect(linked.stdout).toContain("mcp:github:resource:facebook/react/issues/7");

    // Unknown resource ⇒ fail-closed, no link.
    const unknown = await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/999", "--role", "context"], deps);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("could not read resource");

    // A resource can never be a next-step.
    const asNext = await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/7", "--role", "next-step"], deps);
    expect(asNext.exitCode).toBe(1);
    expect(asNext.stderr).toContain("context-only");

    const continued = await run(f, ["continue", id], deps);
    expect(continued.stdout).toContain("[resource:facebook/react/issues/7] Fix the render loop");
    expect(continued.stdout).toContain("Concurrent renders drop updates.");
  });

  it("fails closed when the only resource is unreachable — no empty delivery or fabricated title", async () => {
    const f = fixture();
    // Link while reachable, then resolve while the server is down.
    const started = await run(f, ["thread", "start", "Ship", "the", "adapter", "--kind", "work"], { mcpResourceCaller: githubFakeCaller(true) });
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/7", "--role", "context"], { mcpResourceCaller: githubFakeCaller(true) });

    const continued = await run(f, ["continue", id], { mcpResourceCaller: githubFakeCaller(false) });
    expect(continued.exitCode).toBe(1);
    expect(continued.stderr).toContain("has no currently available linked evidence; no delivery was recorded");
    expect(continued.stdout).not.toContain("Fix the render loop");
  });

  it("fails closed with 'connect the MCP server first' when no MCP runtime is wired", async () => {
    const f = fixture();
    const deps: AttunementCommandDeps = { mcpResourceCaller: undefined };
    const started = await run(f, ["thread", "start", "Ship", "the", "adapter", "--kind", "work"], deps);
    const id = threadId(started.stdout);
    const linked = await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/7", "--role", "context"], deps);
    expect(linked.exitCode).toBe(1);
    expect(linked.stderr).toContain("connect the MCP server 'github' first");
  });
});

describe("muse thread stats — kill-criterion instrument", () => {
  it("counts outcomes across deliveries and reports the first-20 window", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    const started = await run(f, ["thread", "start", "Track", "outcomes", "--kind", "work"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", TASK.id.slice(0, 13), "--role", "next-step"]);

    for (const outcome of ["used", "used", "rejected", "ignored"]) {
      const continued = await run(f, ["continue", id]);
      const deliveryId = continued.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
      expect(deliveryId).toBeTruthy();
      await run(f, ["thread", "outcome", deliveryId!, outcome]);
    }
    // One more pack opened but left without feedback.
    await run(f, ["continue", id]);

    const stats = await run(f, ["thread", "stats", "--json"]);
    const parsed = JSON.parse(stats.stdout) as {
      totalDeliveries: number;
      withOutcome: number;
      outcomes: Record<string, number>;
      firstPacks: { considered: number; used: number; rejected: number };
      longitudinalGate: { byKind: { work: { distinctUtcDates: number; explicitFeedback: number; remainingFeedback: number } }; status: string };
    };
    expect(parsed.totalDeliveries).toBe(5);
    expect(parsed.withOutcome).toBe(4);
    expect(parsed.outcomes).toEqual({ adjusted: 0, ignored: 1, rejected: 1, used: 2 });
    expect(parsed.firstPacks).toEqual({ considered: 5, rejected: 1, used: 2 });
    expect(parsed.longitudinalGate).toMatchObject({
      byKind: { work: { distinctUtcDates: 1, explicitFeedback: 4, remainingFeedback: 6 } },
      status: "collecting"
    });
    expect(parsed).toEqual(computeContinuityEvaluation(await readAttunementState(f.attunementFile)));

    const text = await run(f, ["thread", "stats"]);
    expect(text.stdout).toContain("Production-authorized numeric readiness");
    expect(text.stdout).toContain("used: 2");
    expect(text.stdout).toContain("rejected 1/5");
    expect(text.stdout).toContain("Longitudinal evidence: collecting");
    expect(text.stdout).toContain("work: feedback 4/10 across 1/2 UTC dates; 6 feedback and 1 date remaining");
    expect(text.stdout).toContain("All recorded technical evidence");
  });

  it("reports zeros on empty state without crashing", async () => {
    const f = fixture();
    const stats = await run(f, ["thread", "stats", "--json"]);
    expect(stats.exitCode).toBeUndefined();
    const parsed = JSON.parse(stats.stdout) as { totalDeliveries: number; firstPacks: { considered: number } };
    expect(parsed.totalDeliveries).toBe(0);
    expect(parsed.firstPacks.considered).toBe(0);
  });
});

describe("muse thread review — real first-20 feedback queue", () => {
  it("shows the oldest unreviewed delivery, exact evidence, progress, and copy-ready outcome commands without writing feedback", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    const started = await run(f, ["thread", "start", "Ship", "the", "review", "--kind", "work"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", TASK.id, "--role", "next-step"]);

    const first = await run(f, ["continue", id]);
    const firstDelivery = first.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(firstDelivery).toBeTruthy();
    await run(f, ["thread", "outcome", firstDelivery!, "used"]);
    const second = await run(f, ["continue", id]);
    const secondDelivery = second.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(secondDelivery).toBeTruthy();

    const json = await run(f, ["thread", "review", "--json"]);
    const queue = JSON.parse(json.stdout) as {
      next?: { deliveryId: string; evidence: Array<{ artifact?: { title?: string }; status: string }>; outcomeCommands: Record<string, string> };
      progress: { eligibleDeliveries: number; remainingFeedback: number; remainingPacks: number; reviewedDeliveries: number; target: number };
    };
    expect(queue.progress).toEqual({
      eligibleDeliveries: 2,
      remainingFeedback: 1,
      remainingPacks: 18,
      reviewedDeliveries: 1,
      target: 20
    });
    expect(queue.next?.deliveryId).toBe(secondDelivery);
    expect(queue.next?.evidence).toEqual([
      expect.objectContaining({ artifact: expect.objectContaining({ title: TASK.title }), status: "available" })
    ]);
    expect(queue.next?.outcomeCommands).toEqual({
      adjusted: `muse thread outcome ${secondDelivery!} adjusted`,
      ignored: `muse thread outcome ${secondDelivery!} ignored`,
      rejected: `muse thread outcome ${secondDelivery!} rejected`,
      used: `muse thread outcome ${secondDelivery!} used`
    });
    const { outcomeCommands: _commands, ...cliNextDomain } = queue.next!;
    const cliDomain = { next: cliNextDomain, progress: queue.progress };
    const coreDomain = await prepareContinuityReview(
      await readAttunementState(f.attunementFile),
      createLocalExactArtifactResolver({ notesDir: f.notesDir, tasksFile: f.taskFile })
    );
    expect(cliDomain).toEqual(coreDomain);

    const text = await run(f, ["thread", "review"]);
    expect(text.stdout).toContain("First-20 Continuity review: 1/2 opened packs have feedback");
    expect(text.stdout).toContain(`Next unreviewed: ${secondDelivery!}`);
    expect(text.stdout).toContain(`[local:task:${TASK.id}] ${TASK.title}`);
    expect(text.stdout).toContain(`used: muse thread outcome ${secondDelivery!} used`);

    const stats = JSON.parse((await run(f, ["thread", "stats", "--json"])).stdout) as { withOutcome: number };
    expect(stats.withOutcome).toBe(1);
  });
});
