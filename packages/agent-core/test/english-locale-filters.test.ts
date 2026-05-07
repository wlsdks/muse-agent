import { describe, expect, it } from "vitest";

import {
  createEnglishCasualLureStripResponseFilter,
  createEnglishGreetingStripResponseFilter
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
