import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { detectChatExport, ingestChatExport, registerIngestCommand, slugifyTitle } from "./chat-export-ingest.js";
import type { ProgramIO } from "./program.js";

const chatgptExport = [
  {
    title: "Q3 launch plan",
    create_time: 1_700_000_000,
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["a"] },
      a: { id: "a", message: { author: { role: "system" }, create_time: 1, content: { content_type: "text", parts: ["you are a helpful assistant"] } } },
      b: { id: "b", message: { author: { role: "user" }, create_time: 10, content: { content_type: "text", parts: ["who owns the launch deck?"] } } },
      c: { id: "c", message: { author: { role: "assistant" }, create_time: 20, content: { content_type: "text", parts: ["Jin owns the deck; ship the beta on the 12th."] } } },
      img: { id: "img", message: { author: { role: "user" }, create_time: 15, content: { content_type: "image_asset_pointer", parts: [{ asset_pointer: "file-x" }] } } }
    }
  }
];

const claudeExport = [
  {
    uuid: "u1",
    name: "Insurance renewal",
    created_at: "2026-05-01T09:00:00Z",
    chat_messages: [
      { sender: "human", text: "when does my home insurance renew?" },
      { sender: "assistant", content: [{ type: "text", text: "Policy 7741-A renews 2026-09-14." }] },
      { sender: "tool", text: "(ignored non-conversational)" }
    ]
  }
];

describe("detectChatExport", () => {
  it("recognises ChatGPT (mapping) and Claude (chat_messages) shapes; rejects others", () => {
    expect(detectChatExport(chatgptExport)).toBe("chatgpt");
    expect(detectChatExport(claudeExport)).toBe("claude");
    expect(detectChatExport([])).toBeUndefined();
    expect(detectChatExport([{ foo: 1 }])).toBeUndefined();
    expect(detectChatExport({ not: "an array" })).toBeUndefined();
  });

  it("accepts the `{ conversations: [...] }` object-wrapper shape (common ChatGPT export)", () => {
    expect(detectChatExport({ conversations: chatgptExport })).toBe("chatgpt");
    expect(detectChatExport({ conversations: claudeExport })).toBe("claude");
    const ingested = ingestChatExport({ conversations: chatgptExport });
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.markdown).toContain("Jin owns the deck");
  });
});

describe("ingestChatExport — ChatGPT", () => {
  it("orders turns by create_time, keeps user+assistant, drops system + non-text parts", () => {
    const [conv] = ingestChatExport(chatgptExport);
    expect(conv!.title).toBe("Q3 launch plan");
    expect(conv!.slug).toBe("q3-launch-plan");
    expect(conv!.createdIso).toBe("2023-11-14T22:13:20.000Z");
    expect(conv!.markdown).toContain("**You:** who owns the launch deck?");
    expect(conv!.markdown).toContain("**Assistant:** Jin owns the deck");
    expect(conv!.markdown).not.toContain("helpful assistant"); // system dropped
    expect(conv!.markdown).not.toContain("asset_pointer"); // non-text part dropped
    // user turn precedes assistant turn (create_time order)
    expect(conv!.markdown.indexOf("**You:**")).toBeLessThan(conv!.markdown.indexOf("**Assistant:**"));
  });
});

describe("ingestChatExport — Claude", () => {
  it("maps human→You, reads .text or .content[].text, drops tool turns", () => {
    const [conv] = ingestChatExport(claudeExport);
    expect(conv!.title).toBe("Insurance renewal");
    expect(conv!.createdIso).toBe("2026-05-01T09:00:00Z");
    expect(conv!.markdown).toContain("**You:** when does my home insurance renew?");
    expect(conv!.markdown).toContain("**Assistant:** Policy 7741-A renews 2026-09-14.");
    expect(conv!.markdown).not.toContain("non-conversational");
  });
});

describe("ingestChatExport — robustness", () => {
  it("returns [] for an unrecognized / empty export and skips a conversation with no text", () => {
    expect(ingestChatExport([{ foo: 1 }])).toEqual([]);
    expect(ingestChatExport([{ name: "empty", chat_messages: [{ sender: "human", text: "" }] }])).toEqual([]);
  });

  it("de-collides slugs for same-titled conversations", () => {
    const dup = [
      { name: "notes", chat_messages: [{ sender: "human", text: "a" }] },
      { name: "notes", chat_messages: [{ sender: "human", text: "b" }] }
    ];
    expect(ingestChatExport(dup).map((c) => c.slug)).toEqual(["notes", "notes-2"]);
  });
});

async function runIngest(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: ProgramIO = { stderr: (m) => stderr.push(m), stdout: (m) => stdout.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerIngestCommand(program, io);
    await program.parseAsync(["node", "muse", "ingest", ...args]);
    exitCode = process.exitCode;
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    process.exitCode = prevExit;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function tmpFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "muse-ingest-")), name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("muse ingest — error envelope", () => {
  it("unreadable file → `muse ingest:`-prefixed stderr, exit 1, stdout empty", async () => {
    const r = await runIngest([join("/nonexistent-muse-test", "conversations.json")]);
    expect(r.stderr).toMatch(/^muse ingest: Could not read '/u);
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });

  it("non-JSON, non-mbox content → `muse ingest:`-prefixed parse error, exit 1, stdout empty", async () => {
    const r = await runIngest([tmpFile("junk.json", "this is not json {[")]);
    expect(r.stderr).toMatch(/^muse ingest: Could not parse '.*' as JSON/u);
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });

  it("valid JSON of an unrecognized shape → `muse ingest:`-prefixed unrecognized error, exit 1, stdout empty", async () => {
    const r = await runIngest([tmpFile("weird.json", JSON.stringify([{ foo: 1 }]))]);
    expect(r.stderr).toBe("muse ingest: Unrecognized export — expected a ChatGPT/Claude `conversations.json` (array of conversations) or an .mbox mail archive.\n");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });
});

describe("slugifyTitle", () => {
  it("keeps hangul + alnum, collapses the rest, falls back when empty", () => {
    expect(slugifyTitle("Q3 / Launch!!", "fb")).toBe("q3-launch");
    expect(slugifyTitle("보험 갱신", "fb")).toBe("보험-갱신");
    expect(slugifyTitle("###", "fb-7")).toBe("fb-7");
  });
});
