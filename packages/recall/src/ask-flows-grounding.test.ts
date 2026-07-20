import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScheduledJob } from "@muse/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFlowsGroundingCore, selectFlows } from "./ask-flows-grounding.js";

let jobSeq = 0;

/** An in-memory `ScheduledJob` (Date fields, as the revived store hands them to
 * selectFlows) — distinct from the raw JSON the file-store tests below write
 * to disk (string dates, the on-disk shape). */
function scheduledJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  jobSeq += 1;
  return {
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    cronExpression: "0 8 * * *",
    enabled: true,
    id: `job-${String(jobSeq)}`,
    jobType: "agent",
    maxRetryCount: 3,
    name: "아침 브리핑 요약",
    retryOnFailure: false,
    tags: [],
    timezone: "Asia/Seoul",
    toolArguments: {},
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}

/** The on-disk JSON shape `FileScheduledJobStore` reads (string dates). */
function jobJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  jobSeq += 1;
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    cronExpression: "0 8 * * *",
    enabled: true,
    id: `job-${String(jobSeq)}`,
    jobType: "agent",
    name: "아침 브리핑 요약",
    timezone: "Asia/Seoul",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

let dir: string;
let storeFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-flows-grounding-"));
  storeFile = join(dir, "scheduled-jobs.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("selectFlows — deterministic, no-embed selection", () => {
  const jobs: readonly ScheduledJob[] = [
    scheduledJob({ description: "매일 아침 요약", enabled: true, name: "아침 브리핑 요약" }),
    scheduledJob({ description: "노트 파일을 백업소로 복사", enabled: false, name: "노트 백업 실행" }),
    scheduledJob({ enabled: true, name: "주간 회고 정리" })
  ];

  it("an automation-ENUMERATION intent (KO, bare stem) returns every job, enabled first", () => {
    const out = selectFlows(jobs, "내 자동화 뭐 등록돼 있어?");
    expect(out).toHaveLength(3);
    const enabledFlags = out.map((j) => j.enabled);
    // every `true` precedes every `false` (enabled-first, stable ties keep store order)
    const firstFalse = enabledFlags.indexOf(false);
    expect(firstFalse === -1 || enabledFlags.slice(firstFalse).every((e) => !e)).toBe(true);
  });

  it("a KO particle-attached automation word ('자동화를') still hits intent via stem-prefix matching", () => {
    const out = selectFlows(jobs, "등록된 자동화를 보여줘");
    expect(out).toHaveLength(3);
  });

  it("an EN automation-intent query enumerates every job too", () => {
    const out = selectFlows(jobs, "what automations do I have?");
    expect(out).toHaveLength(3);
  });

  it("a name/description-overlap query (no intent keyword) ranks by overlap, not enumeration", () => {
    const out = selectFlows(jobs, "노트 백업 언제 돌아?");
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("노트 백업 실행");
  });

  it("an unrelated query matches nothing", () => {
    expect(selectFlows(jobs, "서울 날씨 어때?")).toEqual([]);
  });

  it("an empty query matches nothing (never a blind enumeration)", () => {
    expect(selectFlows(jobs, "")).toEqual([]);
  });

  it("caps enumeration at max (default 12), enabled ones sorted first", () => {
    const many = Array.from({ length: 15 }, (_, i) => scheduledJob({ enabled: i % 3 !== 0, name: `flow ${String(i)}` }));
    const out = selectFlows(many, "what automations do I have?");
    expect(out).toHaveLength(12);
  });
});

describe("buildFlowsGroundingCore — file-store read, fail-soft, flag-gated", () => {
  it("reads the seeded store and returns matched flows + a rendered block", async () => {
    await writeFile(storeFile, JSON.stringify({ jobs: [jobJson({ name: "아침 브리핑 요약" })] }), "utf8");
    const result = await buildFlowsGroundingCore({ flows: true, flowsFile: storeFile, query: "내 자동화 뭐 있어?" });
    expect(result.matchedFlows).toHaveLength(1);
    expect(result.flowsBlock).toContain("[flow: 아침 브리핑 요약]");
  });

  it("flows:false skips the read entirely — empty result even with a real store present", async () => {
    await writeFile(storeFile, JSON.stringify({ jobs: [jobJson()] }), "utf8");
    const result = await buildFlowsGroundingCore({ flows: false, flowsFile: storeFile, query: "내 자동화 뭐 있어?" });
    expect(result.matchedFlows).toEqual([]);
    expect(result.flowsBlock).toBe("(no matching automations)");
  });

  it("a MISSING store file fails soft to empty, never throws", async () => {
    const result = await buildFlowsGroundingCore({ flows: true, flowsFile: join(dir, "does-not-exist.json"), query: "내 자동화 뭐 있어?" });
    expect(result.matchedFlows).toEqual([]);
  });

  it("a CORRUPT store file fails soft to empty, never throws", async () => {
    await writeFile(storeFile, "{ this is not valid json", "utf8");
    const result = await buildFlowsGroundingCore({ flows: true, flowsFile: storeFile, query: "내 자동화 뭐 있어?" });
    expect(result.matchedFlows).toEqual([]);
  });

  it("an empty-jobs store yields an honest empty result, not a fabricated flow", async () => {
    await writeFile(storeFile, JSON.stringify({ jobs: [] }), "utf8");
    const result = await buildFlowsGroundingCore({ flows: true, flowsFile: storeFile, query: "내 자동화 뭐 있어?" });
    expect(result.matchedFlows).toEqual([]);
    expect(result.flowsBlock).toBe("(no matching automations)");
  });

  it("SECRET NON-LEAK end-to-end: a seeded job carrying a webhook token / toolArguments / agentPrompt never surfaces any of it in the rendered block", async () => {
    await writeFile(storeFile, JSON.stringify({
      jobs: [jobJson({
        agentPrompt: "SECRET_AGENT_PROMPT_MARKER",
        jobType: "mcp_tool",
        mcpServerName: "notion",
        name: "노트 백업 실행",
        toolArguments: { apiKey: "sk-FAKELEAK" },
        toolName: "backup_page",
        webhookTriggerToken: "wht_SECRETSECRET",
        webhookUrl: "https://hooks.example.com/T000/B000/LEAKME"
      })]
    }), "utf8");
    const result = await buildFlowsGroundingCore({ flows: true, flowsFile: storeFile, query: "내 자동화 뭐 있어?" });
    expect(result.matchedFlows).toHaveLength(1);
    for (const secret of ["SECRET_AGENT_PROMPT_MARKER", "sk-FAKELEAK", "wht_SECRETSECRET", "LEAKME"]) {
      expect(result.flowsBlock).not.toContain(secret);
    }
    expect(result.flowsBlock).toContain("trigger: schedule/webhook");
    expect(result.flowsBlock).toContain("does: tool: notion.backup_page");
  });
});
