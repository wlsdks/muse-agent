import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRunContext, BackgroundReviewInput } from "@muse/agent-core";
import type { UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import { FileSystemSkillLoader } from "@muse/skills";
import { describe, expect, it } from "vitest";

import { createReviewSkillArm } from "../src/background-review-arms.js";

const provider: ModelProvider = {
  id: "stub",
  async generate() {
    return {
      id: "response",
      model: "stub",
      output: [
        "name: export-then-attach",
        "description: Use when sending a document; convert it before attaching.",
        "body:",
        "1. Convert the document to PDF.",
        "2. Attach the PDF."
      ].join("\n")
    };
  },
  async listModels() {
    return [];
  },
  async *stream() {}
};

describe("createReviewSkillArm — governed adaptation", () => {
  it("stages an unattended draft outside the active skill catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-review-probation-"));
    const arm = createReviewSkillArm({
      defaultModel: "stub",
      env: {
        MUSE_AUTHORED_SKILLS_DIR: dir,
        MUSE_BACKGROUND_REVIEW_ENABLED: "true",
        MUSE_BACKGROUND_REVIEW_SKILL_ARM: "true"
      },
      modelProvider: provider,
      userMemoryStore: {} as UserMemoryStore
    });
    expect(arm).toBeDefined();

    const context = {
      input: {
        messages: [
          { content: "send the report to my manager", role: "user" },
          { content: "I attached the .docx.", role: "assistant" },
          { content: "no, that's wrong — always convert to PDF first then attach", role: "user" }
        ],
        metadata: {},
        model: "stub"
      }
    } as AgentRunContext;
    await arm!({ context, userId: "user" } as BackgroundReviewInput);

    const active = await new FileSystemSkillLoader({
      roots: [{ path: dir, source: "authored" }]
    }).loadAll();
    const probation = await new FileSystemSkillLoader({
      roots: [{ path: join(dir, ".probation"), source: "authored" }]
    }).loadAll();
    expect(active).toEqual([]);
    expect(probation.map((skill) => skill.name)).toEqual(["export-then-attach"]);
  });
});
