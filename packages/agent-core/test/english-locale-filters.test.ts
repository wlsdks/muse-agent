import { describe, expect, it } from "vitest";

import {
  createEnglishCasualLureStripResponseFilter,
  createEnglishGreetingStripResponseFilter,
  createFabricationRequestRefusalFilter,
  createZeroResultOverclaimResponseFilter
} from "../src/response-filters.js";
import type { ResponseFilterContext } from "../src/types.js";

const baseResponse = (output: string) => ({ id: "r-1", model: "diagnostic/smoke", output });

const baseContext: ResponseFilterContext = {
  input: { messages: [{ content: "any", role: "user" }], model: "diagnostic/smoke" },
  response: { id: "r-1", model: "diagnostic/smoke", output: "" },
  runId: "run-1",
  toolsUsed: []
};

describe("createEnglishGreetingStripResponseFilter", () => {
  const filter = createEnglishGreetingStripResponseFilter();

  it("strips a leading 'Hi there!' greeting", async () => {
    const result = await filter.apply(baseResponse("Hi there! Here is the answer."), baseContext);
    expect(result.output).toBe("Here is the answer.");
  });

  it("strips a leading 'Hello,' greeting with a name fragment", async () => {
    const result = await filter.apply(
      baseResponse("Hello, friend! The answer is 42."),
      baseContext
    );
    expect(result.output).toBe("The answer is 42.");
  });

  it("strips 'Good morning!' time-of-day greetings", async () => {
    const result = await filter.apply(
      baseResponse("Good morning! Here are your tasks for today."),
      baseContext
    );
    expect(result.output).toBe("Here are your tasks for today.");
  });

  it("strips 'Nice to meet you' politeness lead", async () => {
    const result = await filter.apply(
      baseResponse("Nice to meet you. The launch ships on Friday."),
      baseContext
    );
    expect(result.output).toBe("The launch ships on Friday.");
  });

  it("returns the response unchanged when no greeting is present", async () => {
    const original = baseResponse("Just the answer, no preamble.");
    const result = await filter.apply(original, baseContext);
    expect(result.output).toBe(original.output);
  });

  it("does not strip a sentence that merely starts with 'Hi-resolution'", async () => {
    const original = baseResponse("Hi-resolution mode is enabled.");
    const result = await filter.apply(original, baseContext);
    expect(result.output).toBe(original.output);
  });

  it("strips a leading compliance filler (Sure! / Certainly. / Of course! / Got it!)", async () => {
    for (const [input, expected] of [
      ["Sure! The capital of France is Paris.", "The capital of France is Paris."],
      ["Certainly. Here are three options.", "Here are three options."],
      ["Of course! 42.", "42."],
      ["Sure thing! Done.", "Done."],
      ["Got it! Task added.", "Task added."],
      ["Understood. Proceeding now.", "Proceeding now."]
    ] as const) {
      const result = await filter.apply(baseResponse(input), baseContext);
      expect(result.output).toBe(expected);
    }
  });

  it("strips filler then greeting in the same chain", async () => {
    const result = await filter.apply(baseResponse("Sure! Hi there! Paris."), baseContext);
    expect(result.output).toBe("Paris.");
  });

  it("strips stacked lead-ins regardless of order (reasoning-off models pile them up)", async () => {
    for (const [input, expected] of [
      ["Sure! Of course! Paris.", "Paris."],
      ["Sure! Certainly. Got it! Task added.", "Task added."],
      ["Hi there! Sure! Paris.", "Paris."],
      ["Good morning! Of course! Understood. The answer is 42.", "The answer is 42."]
    ] as const) {
      const result = await filter.apply(baseResponse(input), baseContext);
      expect(result.output).toBe(expected);
    }
  });

  it("does NOT strip real content that merely starts with a filler word", async () => {
    for (const input of [
      "Surely the deadline is Friday.",
      "Of course not. The Earth is not flat.",
      "Absolutely fascinating: the result doubled.",
      "Sure, the answer is Paris."
    ]) {
      const result = await filter.apply(baseResponse(input), baseContext);
      expect(result.output).toBe(input);
    }
  });

  it("does NOT strip a greeting-only / filler-only reply down to empty (silence is worse)", async () => {
    for (const only of ["Hi there! ", "Good morning! ", "Sure! ", "Of course! "]) {
      const result = await filter.apply(baseResponse(only), baseContext);
      expect(result.output).toBe(only);
    }
  });
});

describe("createEnglishCasualLureStripResponseFilter", () => {
  const filter = createEnglishCasualLureStripResponseFilter();

  it("strips 'Let me know if you need anything else.' from the tail", async () => {
    const result = await filter.apply(
      baseResponse("The answer is 42. Let me know if you need anything else."),
      baseContext
    );
    expect(result.output).toBe("The answer is 42.");
  });

  it("strips 'Hope that helps!' from the tail", async () => {
    const result = await filter.apply(
      baseResponse("The release ships Friday. Hope that helps!"),
      baseContext
    );
    expect(result.output).toBe("The release ships Friday.");
  });

  it("strips 'I'd be happy to help' lure", async () => {
    const result = await filter.apply(
      baseResponse("Documentation is in the wiki. I'd be happy to help with anything else."),
      baseContext
    );
    expect(result.output).toBe("Documentation is in the wiki.");
  });

  it("strips 'Anything else I can help with?' question lure", async () => {
    const result = await filter.apply(
      baseResponse("Status is green. Anything else I can help with?"),
      baseContext
    );
    expect(result.output).toBe("Status is green.");
  });

  it("strips a standalone 'Cheers!' tail", async () => {
    const result = await filter.apply(
      baseResponse("All checks passed. Cheers!"),
      baseContext
    );
    expect(result.output).toBe("All checks passed.");
  });

  it("does NOT strip the tail when a tool was used (work response stays as-is)", async () => {
    const original = baseResponse("Found 3 matches. Let me know if you need anything else.");
    const result = await filter.apply(original, { ...baseContext, toolsUsed: ["search"] });
    expect(result.output).toBe(original.output);
  });

  it("returns the response unchanged when no lure is present", async () => {
    const original = baseResponse("The answer is 42.");
    const result = await filter.apply(original, baseContext);
    expect(result.output).toBe(original.output);
  });

  it("skips long responses (>500 chars) to avoid touching real content", async () => {
    const longBody = "Detailed analysis. ".repeat(40); // ~760 chars
    const original = baseResponse(`${longBody}Hope that helps!`);
    const result = await filter.apply(original, baseContext);
    expect(result.output).toBe(original.output);
  });
});

describe("createFabricationRequestRefusalFilter (options)", () => {
  it("uses default Korean detection terms + refusal text when no options are supplied", async () => {
    const filter = createFabricationRequestRefusalFilter();
    const result = await filter.apply(
      baseResponse("임의로 만든 비공개 문서 요약입니다."),
      {
        ...baseContext,
        input: { messages: [{ content: "없는 비밀 문서를 찾아서 임의로 요약해줘", role: "user" }], model: "diagnostic/smoke" }
      }
    );
    expect(result.output).toContain("제공할 수 없습니다");
  });

  it("triggers on the secret+discovery combo IN ISOLATION (no invent/missing terms present)", async () => {
    // The default KO test conflates both trigger combos in one prompt; this
    // isolates the second — a secret-document discovery ask with NO invent/missing
    // term — so a regression in the secret+discovery branch can't hide behind the
    // invent+missing branch.
    const filter = createFabricationRequestRefusalFilter();
    const result = await filter.apply(baseResponse("여기 비밀 문서 요약입니다."), {
      ...baseContext,
      input: { messages: [{ content: "비밀 문서를 검색해줘", role: "user" }], model: "diagnostic/smoke" }
    });
    expect(result.output).toContain("제공할 수 없습니다");
  });

  it("does NOT refuse on a PARTIAL combo — invent without missing, or secret without discovery (AND, not OR)", async () => {
    const filter = createFabricationRequestRefusalFilter();
    // invent term ('임의로') but no missing term → not a fabrication request
    const inventOnly = await filter.apply(baseResponse("원본 응답"), {
      ...baseContext,
      input: { messages: [{ content: "임의로 요약해줘", role: "user" }], model: "diagnostic/smoke" }
    });
    expect(inventOnly.output).toBe("원본 응답");
    // secret term but no discovery/missing term → not a fabrication request
    const secretOnly = await filter.apply(baseResponse("원본 응답"), {
      ...baseContext,
      input: { messages: [{ content: "비밀 문서 보여줘", role: "user" }], model: "diagnostic/smoke" }
    });
    expect(secretOnly.output).toBe("원본 응답");
  });

  it("emits a custom English refusal text when configured", async () => {
    const filter = createFabricationRequestRefusalFilter({
      inventTerms: ["make up", "fabricate", "invent"],
      missingTerms: ["without source", "not in docs", "doesn't exist"],
      refusalText: "I cannot fabricate content that has no verifiable source."
    });
    const result = await filter.apply(
      baseResponse("Here is the made-up content you wanted."),
      {
        ...baseContext,
        input: {
          messages: [{ content: "Make up a summary that doesn't exist in the docs.", role: "user" }],
          model: "diagnostic/smoke"
        }
      }
    );
    expect(result.output).toBe("I cannot fabricate content that has no verifiable source.");
  });

  it("does not refuse when neither invent+missing nor secret+discovery combos appear", async () => {
    const filter = createFabricationRequestRefusalFilter();
    const original = baseResponse("Summarizing public docs.");
    const result = await filter.apply(original, {
      ...baseContext,
      input: { messages: [{ content: "Summarize the public README.", role: "user" }], model: "diagnostic/smoke" }
    });
    expect(result.output).toBe(original.output);
  });
});

describe("createZeroResultOverclaimResponseFilter (options)", () => {
  it("default behavior: no tool-prefix gate — strips overclaim line whenever both Korean patterns match", async () => {
    const filter = createZeroResultOverclaimResponseFilter();
    const result = await filter.apply(
      baseResponse(
        [
          "전체 이슈: 0건",
          "모든 이슈가 정리되었거나 현재 활발한 작업이 진행되고 있지 않은 것으로 보입니다.",
          "다른 필터로 다시 조회할 수 있습니다."
        ].join("\n")
      ),
      baseContext
    );
    expect(result.output).toContain("전체 이슈: 0건");
    expect(result.output).toContain("다른 필터");
    expect(result.output).not.toContain("활발한 작업");
  });

  it("does NOT strip on a PARTIAL match — zero-result without an overclaim line, or an overclaim when results WERE found (AND, not OR)", async () => {
    const filter = createZeroResultOverclaimResponseFilter();
    // zero-result present but NO overclaim language → nothing to strip
    const zeroOnly = baseResponse("전체 이슈: 0건\n목록을 확인하세요.");
    expect((await filter.apply(zeroOnly, baseContext)).output).toBe(zeroOnly.output);
    // overclaim language but results WERE found (no zero-result) → the "all done"
    // line is legitimate, not an overclaim; stripping it would erase a true result.
    const overclaimWithResults = baseResponse("이슈 3건을 처리했습니다.\n모든 작업이 완료되었습니다.");
    expect((await filter.apply(overclaimWithResults, baseContext)).output).toBe(overclaimWithResults.output);
  });

  it("opt-in tool-prefix gate skips the strip when no matching tool was used", async () => {
    const filter = createZeroResultOverclaimResponseFilter({
      workspaceToolPrefixes: ["search_"]
    });
    const original = baseResponse(
      [
        "전체 이슈: 0건",
        "모든 이슈가 정리되었거나 현재 활발한 작업이 진행되고 있지 않은 것으로 보입니다."
      ].join("\n")
    );
    const result = await filter.apply(original, baseContext);
    expect(result.output).toBe(original.output);
  });

  it("opt-in tool-prefix gate strips when a matching tool was used", async () => {
    const filter = createZeroResultOverclaimResponseFilter({
      workspaceToolPrefixes: ["search_"]
    });
    const result = await filter.apply(
      baseResponse(
        [
          "전체 이슈: 0건",
          "모든 이슈가 정리되었거나 현재 활발한 작업이 진행되고 있지 않은 것으로 보입니다."
        ].join("\n")
      ),
      { ...baseContext, toolsUsed: ["search_issues"] }
    );
    expect(result.output).not.toContain("활발한 작업");
  });

  it("custom English patterns: strips an English overclaim line on a zero-result response", async () => {
    const filter = createZeroResultOverclaimResponseFilter({
      overclaimPattern: /everything\s+is\s+running\s+smoothly|all\s+issues\s+resolved/iu,
      zeroResultPattern: /\b0\s+results?\b|no\s+matches\s+found/iu
    });
    const result = await filter.apply(
      baseResponse(
        [
          "Search returned 0 results.",
          "Everything is running smoothly with no open work to report.",
          "Try a different filter."
        ].join("\n")
      ),
      baseContext
    );
    expect(result.output).toContain("Search returned 0 results.");
    expect(result.output).toContain("Try a different filter.");
    expect(result.output).not.toContain("Everything is running smoothly");
  });
});
