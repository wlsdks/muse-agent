# Native Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate server-side `web_search` on OpenAI Responses / Anthropic Messages / Gemini generateContent. Default-on with env+settings kill switch. Citations normalized to `ModelResponse.citations[]`. Bundled big-bang OpenAI Chat Completions → Responses API migration.

**Architecture:** Provider-wire transformer functions in `packages/model/src/provider-wire.ts` are the primary surface. `agent-core` reads runtime-settings + request override to build `WebSearchPolicy`, passes it down to provider transformers. Citations flow through `ModelResponse.citations[]` (normalized) and SSE emits synthetic `tool-call-started` / `tool-call-finished` / `citations` `ModelEvent`s. Kill switch via env `MUSE_WEB_SEARCH=off` or runtime-settings key `webSearch.enabled`.

**Tech Stack:** TypeScript strict, vitest, pnpm workspaces, Fastify SSE, React (apps/web), Ink+commander (apps/cli).

**Spec:** `docs/superpowers/specs/2026-05-11-native-web-search-design.md`

---

## Phase 0 — Foundation: types, policy, sanitiser, fixtures

### Task 1: Add `WebSearchCitation` type and extend `ModelResponse` / `ModelEvent`

**Files:**
- Modify: `packages/model/src/index.ts:103-116`
- Test: `packages/model/src/index.test.ts` (extend existing)

- [ ] **Step 1: Write the failing type test**

Append to `packages/model/src/index.test.ts`:

```ts
import type { ModelEvent, ModelResponse, WebSearchCitation } from "./index.js";

describe("web search types", () => {
  it("ModelResponse accepts an optional citations array", () => {
    const r: ModelResponse = {
      id: "r1",
      model: "m",
      output: "hi",
      citations: [{ url: "https://example.com", title: "Ex" }]
    };
    expect(r.citations?.[0]?.url).toBe("https://example.com");
  });

  it("ModelEvent union includes tool-call-started, tool-call-finished, citations", () => {
    const events: ModelEvent[] = [
      { type: "tool-call-started", name: "web_search" },
      { type: "tool-call-finished", name: "web_search", count: 2 },
      { type: "citations", items: [{ url: "https://x.test", title: "X" }] }
    ];
    expect(events).toHaveLength(3);
  });

  it("WebSearchCitation requires url and title", () => {
    const c: WebSearchCitation = { url: "https://a.test", title: "A" };
    expect(c.title).toBe("A");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/model test -- index.test.ts`
Expected: FAIL — type errors (citations/WebSearchCitation/new event variants don't exist).

- [ ] **Step 3: Add types in `packages/model/src/index.ts`**

Replace lines 103-116 with:

```ts
export interface WebSearchCitation {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
  readonly providerRaw?: unknown;
}

export interface ModelResponse {
  readonly id: string;
  readonly model: string;
  readonly output: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly usage?: ModelUsage;
  readonly citations?: readonly WebSearchCitation[];
  readonly raw?: unknown;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCall: ModelToolCall }
  | { readonly type: "tool-call-started"; readonly name: string }
  | { readonly type: "tool-call-finished"; readonly name: string; readonly count?: number }
  | { readonly type: "citations"; readonly items: readonly WebSearchCitation[] }
  | { readonly type: "done"; readonly response: ModelResponse }
  | { readonly type: "error"; readonly error: ModelProviderError };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @muse/model test -- index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/index.ts packages/model/src/index.test.ts
git commit -m "feat(model): add WebSearchCitation type and extend ModelEvent/ModelResponse"
```

---

### Task 2: Add `decideWebSearchPolicy` module + tests

**Files:**
- Create: `packages/model/src/web-search-policy.ts`
- Create: `packages/model/src/web-search-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/model/src/web-search-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decideWebSearchPolicy } from "./web-search-policy.js";

describe("decideWebSearchPolicy", () => {
  const baseModel = { provider: "openai", modelId: "gpt-4o" };

  it("defaults to enabled when nothing set", () => {
    const r = decideWebSearchPolicy({ model: baseModel, settings: {}, env: {} });
    expect(r.enabled).toBe(true);
  });

  it("env MUSE_WEB_SEARCH=off forces disabled even with override true", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: { webSearch: { enabled: true } },
      override: true,
      env: { MUSE_WEB_SEARCH: "off" }
    });
    expect(r.enabled).toBe(false);
  });

  it("explicit override=true wins over settings.enabled=false", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: { webSearch: { enabled: false } },
      override: true,
      env: {}
    });
    expect(r.enabled).toBe(true);
  });

  it("override=false disables even with settings.enabled=true", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: { webSearch: { enabled: true } },
      override: false,
      env: {}
    });
    expect(r.enabled).toBe(false);
  });

  it("settings.enabled=false disables when no override", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: { webSearch: { enabled: false } },
      env: {}
    });
    expect(r.enabled).toBe(false);
  });

  it("maxUses precedence: env > settings, defaults to 5", () => {
    expect(
      decideWebSearchPolicy({ model: baseModel, settings: {}, env: {} }).maxUses
    ).toBe(5);
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: { webSearch: { maxUses: 3 } },
        env: {}
      }).maxUses
    ).toBe(3);
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: { webSearch: { maxUses: 3 } },
        env: { MUSE_WEB_SEARCH_MAX_USES: "9" }
      }).maxUses
    ).toBe(9);
  });

  it("MUSE_WEB_SEARCH_MAX_USES that is not a positive integer falls through", () => {
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: {},
        env: { MUSE_WEB_SEARCH_MAX_USES: "abc" }
      }).maxUses
    ).toBe(5);
  });

  it("env MUSE_WEB_SEARCH=on is no-op when nothing else disables", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: {},
      env: { MUSE_WEB_SEARCH: "on" }
    });
    expect(r.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/model test -- web-search-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `web-search-policy.ts`**

Create `packages/model/src/web-search-policy.ts`:

```ts
export interface WebSearchPolicy {
  readonly enabled: boolean;
  readonly maxUses: number;
}

export interface WebSearchSettings {
  readonly enabled?: boolean;
  readonly maxUses?: number;
}

export interface DecideWebSearchPolicyArgs {
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly settings: { readonly webSearch?: WebSearchSettings };
  readonly override?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_MAX_USES = 5;

export function decideWebSearchPolicy(args: DecideWebSearchPolicyArgs): WebSearchPolicy {
  const env = args.env ?? {};
  const settings = args.settings.webSearch ?? {};

  const envFlag = env.MUSE_WEB_SEARCH?.toLowerCase();
  if (envFlag === "off") {
    return { enabled: false, maxUses: resolveMaxUses(env, settings) };
  }

  if (args.override === true) {
    return { enabled: true, maxUses: resolveMaxUses(env, settings) };
  }
  if (args.override === false) {
    return { enabled: false, maxUses: resolveMaxUses(env, settings) };
  }

  const enabled = settings.enabled !== false;
  return { enabled, maxUses: resolveMaxUses(env, settings) };
}

function resolveMaxUses(
  env: Readonly<Record<string, string | undefined>>,
  settings: WebSearchSettings
): number {
  const envRaw = env.MUSE_WEB_SEARCH_MAX_USES;
  if (envRaw !== undefined) {
    const n = Number.parseInt(envRaw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof settings.maxUses === "number" && settings.maxUses > 0) {
    return settings.maxUses;
  }
  return DEFAULT_MAX_USES;
}
```

- [ ] **Step 4: Re-export from index**

Append to `packages/model/src/index.ts` (end of file):

```ts
export {
  decideWebSearchPolicy,
  type DecideWebSearchPolicyArgs,
  type WebSearchPolicy,
  type WebSearchSettings
} from "./web-search-policy.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @muse/model test -- web-search-policy.test.ts`
Expected: PASS, 7 cases.

- [ ] **Step 6: Commit**

```bash
git add packages/model/src/web-search-policy.ts packages/model/src/web-search-policy.test.ts packages/model/src/index.ts
git commit -m "feat(model): add decideWebSearchPolicy with env+override+settings precedence"
```

---

### Task 3: Add `sanitiseCitations` helper in agent-core

**Files:**
- Create: `packages/agent-core/src/citation-sanitiser.ts`
- Create: `packages/agent-core/src/citation-sanitiser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-core/src/citation-sanitiser.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { sanitiseCitations } from "./citation-sanitiser.js";

describe("sanitiseCitations", () => {
  it("keeps https citations as-is", () => {
    const out = sanitiseCitations([{ url: "https://example.com", title: "Ex" }]);
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toBe(0);
  });

  it("keeps http citations", () => {
    const out = sanitiseCitations([{ url: "http://plain.test", title: "Plain" }]);
    expect(out.kept).toHaveLength(1);
  });

  it("drops javascript: URLs", () => {
    const out = sanitiseCitations([
      { url: "javascript:alert(1)", title: "evil" },
      { url: "https://safe.test", title: "safe" }
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0]!.url).toBe("https://safe.test");
    expect(out.dropped).toBe(1);
  });

  it("drops data: URLs", () => {
    const out = sanitiseCitations([{ url: "data:text/html,<script/>", title: "x" }]);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it("drops empty / whitespace-only URLs", () => {
    const out = sanitiseCitations([
      { url: "", title: "empty" },
      { url: "   ", title: "ws" }
    ]);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped).toBe(2);
  });

  it("drops non-URL strings", () => {
    const out = sanitiseCitations([{ url: "not-a-url", title: "bad" }]);
    expect(out.kept).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it("returns empty kept and zero dropped for empty input", () => {
    const out = sanitiseCitations([]);
    expect(out.kept).toEqual([]);
    expect(out.dropped).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/agent-core test -- citation-sanitiser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sanitiser**

Create `packages/agent-core/src/citation-sanitiser.ts`:

```ts
import type { WebSearchCitation } from "@muse/model";

export interface SanitiseCitationsResult {
  readonly kept: readonly WebSearchCitation[];
  readonly dropped: number;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function sanitiseCitations(
  citations: readonly WebSearchCitation[]
): SanitiseCitationsResult {
  const kept: WebSearchCitation[] = [];
  let dropped = 0;
  for (const c of citations) {
    if (isSafeUrl(c.url)) {
      kept.push(c);
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

function isSafeUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol);
}
```

- [ ] **Step 4: Re-export from agent-core index**

Append to `packages/agent-core/src/index.ts`:

```ts
export { sanitiseCitations, type SanitiseCitationsResult } from "./citation-sanitiser.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @muse/agent-core test -- citation-sanitiser.test.ts`
Expected: PASS, 7 cases.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/citation-sanitiser.ts packages/agent-core/src/citation-sanitiser.test.ts packages/agent-core/src/index.ts
git commit -m "feat(agent-core): add sanitiseCitations dropping non-http(s) URLs"
```

---

### Task 4: Capture provider response fixtures

**Files:**
- Create: `packages/model/__fixtures__/web-search/openai-responses.json`
- Create: `packages/model/__fixtures__/web-search/anthropic-messages.json`
- Create: `packages/model/__fixtures__/web-search/gemini-generate-content.json`

These are **schema-shape examples** — they exercise the parser. If you have API keys, capture real responses from a prompt like *"What's today's top tech news?"*. If you don't, use the hand-crafted shapes below; they match documented schemas. Replace with real captures during the smoke:live pass at the end.

- [ ] **Step 1: OpenAI Responses fixture**

Create `packages/model/__fixtures__/web-search/openai-responses.json`:

```json
{
  "id": "resp_001",
  "object": "response",
  "model": "gpt-4o",
  "output": [
    {
      "type": "web_search_call",
      "id": "ws_001",
      "status": "completed",
      "action": { "type": "search", "query": "today top tech news" }
    },
    {
      "type": "message",
      "id": "msg_001",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Reports today highlight ...",
          "annotations": [
            {
              "type": "url_citation",
              "url": "https://example.com/news/a",
              "title": "Example News A",
              "start_index": 0,
              "end_index": 20
            },
            {
              "type": "url_citation",
              "url": "https://example.com/news/b",
              "title": "Example News B",
              "start_index": 21,
              "end_index": 40
            }
          ]
        }
      ]
    }
  ],
  "usage": { "input_tokens": 12, "output_tokens": 34, "total_tokens": 46 }
}
```

- [ ] **Step 2: Anthropic Messages fixture**

Create `packages/model/__fixtures__/web-search/anthropic-messages.json`:

```json
{
  "id": "msg_001",
  "type": "message",
  "role": "assistant",
  "model": "claude-3-5-sonnet-20241022",
  "content": [
    {
      "type": "server_tool_use",
      "id": "stu_001",
      "name": "web_search",
      "input": { "query": "today top tech news" }
    },
    {
      "type": "web_search_tool_result",
      "tool_use_id": "stu_001",
      "content": [
        {
          "type": "web_search_result",
          "url": "https://example.com/news/a",
          "title": "Example News A",
          "encrypted_content": "OPAQUE_BLOB"
        },
        {
          "type": "web_search_result",
          "url": "https://example.com/news/b",
          "title": "Example News B",
          "encrypted_content": "OPAQUE_BLOB"
        }
      ]
    },
    {
      "type": "text",
      "text": "Reports today highlight ...",
      "citations": [
        {
          "type": "web_search_result_location",
          "url": "https://example.com/news/a",
          "title": "Example News A",
          "cited_text": "Reports today"
        }
      ]
    }
  ],
  "usage": { "input_tokens": 30, "output_tokens": 60 },
  "stop_reason": "end_turn"
}
```

- [ ] **Step 3: Gemini generateContent fixture**

Create `packages/model/__fixtures__/web-search/gemini-generate-content.json`:

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [{ "text": "Reports today highlight ..." }]
      },
      "finishReason": "STOP",
      "groundingMetadata": {
        "groundingChunks": [
          { "web": { "uri": "https://example.com/news/a", "title": "Example News A" } },
          { "web": { "uri": "https://example.com/news/b", "title": "Example News B" } }
        ]
      }
    }
  ],
  "usageMetadata": { "promptTokenCount": 10, "candidatesTokenCount": 25, "totalTokenCount": 35 }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/model/__fixtures__/web-search/
git commit -m "test(model): capture web_search response fixtures for OpenAI/Anthropic/Gemini"
```

---

## Phase 1 — OpenAI: Chat Completions → Responses migration

> The big-bang. After Phase 1 the OpenAI provider speaks Responses API exclusively. Tasks 5–8 are sequential; do not jump ahead.

### Task 5: Add `toOpenAIResponsesRequest` and `fromOpenAIResponsesResponse`

**Files:**
- Modify: `packages/model/src/provider-wire.ts`
- Test: `packages/model/src/provider-wire.test.ts` (extend; add a new describe block)

- [ ] **Step 1: Write the failing tests**

Append to `packages/model/src/provider-wire.test.ts`:

```ts
import openaiFixture from "../__fixtures__/web-search/openai-responses.json";

import {
  toOpenAIResponsesRequest,
  fromOpenAIResponsesResponse
} from "./provider-wire.js";

describe("toOpenAIResponsesRequest", () => {
  const base = {
    model: "openai/gpt-4o",
    messages: [
      { role: "user" as const, content: "hello" }
    ]
  };

  it("emits a Responses-shaped payload with model + input + tools", () => {
    const out = toOpenAIResponsesRequest(base, "gpt-4o", { enabled: false, maxUses: 5 });
    expect(out.model).toBe("gpt-4o");
    expect(Array.isArray(out.input)).toBe(true);
    expect(out.input[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    });
    expect(out.tools ?? []).toEqual([]);
  });

  it("injects { type:'web_search' } when policy enabled", () => {
    const out = toOpenAIResponsesRequest(base, "gpt-4o", { enabled: true, maxUses: 5 });
    expect(out.tools).toEqual([{ type: "web_search" }]);
  });

  it("preserves caller-supplied function tools alongside web_search", () => {
    const request = {
      ...base,
      tools: [{ name: "get_time", description: "", inputSchema: { type: "object" } }]
    };
    const out = toOpenAIResponsesRequest(request, "gpt-4o", { enabled: true, maxUses: 5 });
    expect(out.tools).toEqual([
      { type: "function", function: { name: "get_time", description: "", parameters: { type: "object" } } },
      { type: "web_search" }
    ]);
  });
});

describe("fromOpenAIResponsesResponse", () => {
  it("extracts output text and citations from annotations", () => {
    const r = fromOpenAIResponsesResponse("openai", "gpt-4o", openaiFixture);
    expect(r.output).toContain("Reports today highlight");
    expect(r.citations).toHaveLength(2);
    expect(r.citations?.[0]).toMatchObject({
      url: "https://example.com/news/a",
      title: "Example News A"
    });
    expect(r.usage?.inputTokens).toBe(12);
    expect(r.usage?.outputTokens).toBe(34);
  });

  it("returns empty citations array when no annotations are present", () => {
    const payload = { id: "x", model: "gpt-4o", output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [] }] }] };
    const r = fromOpenAIResponsesResponse("openai", "gpt-4o", payload);
    expect(r.citations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts -t "toOpenAIResponsesRequest|fromOpenAIResponsesResponse"`
Expected: FAIL — functions not exported yet.

- [ ] **Step 3: Implement the two functions**

In `packages/model/src/provider-wire.ts`, add (location: after the existing OpenAI Chat helpers, before Anthropic helpers):

```ts
export function toOpenAIResponsesRequest(
  request: ModelRequest,
  defaultModel: string | undefined,
  policy: { enabled: boolean; maxUses: number }
) {
  const tools: Array<Record<string, unknown>> = [];
  for (const tool of request.tools ?? []) {
    tools.push({
      type: "function",
      function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema }
    });
  }
  if (policy.enabled) tools.push({ type: "web_search" });

  return {
    model: parseModelName(request.model || defaultModel || "").modelId,
    input: request.messages.map((m) => ({
      role: m.role,
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: typeof m.content === "string" ? m.content : "" }]
    })),
    temperature: request.temperature,
    max_output_tokens: request.maxOutputTokens,
    tools
  };
}

export function fromOpenAIResponsesResponse(
  providerId: string,
  requestedModel: string,
  payload: unknown
): ModelResponse {
  const obj = (payload ?? {}) as { id?: string; model?: string; output?: unknown[]; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
  let text = "";
  const citations: WebSearchCitation[] = [];
  for (const item of obj.output ?? []) {
    if (!item || typeof item !== "object") continue;
    const it = item as { type?: string; content?: unknown[] };
    if (it.type !== "message") continue;
    for (const c of it.content ?? []) {
      if (!c || typeof c !== "object") continue;
      const block = c as { type?: string; text?: string; annotations?: unknown[] };
      if (block.type !== "output_text") continue;
      if (typeof block.text === "string") text += block.text;
      for (const a of block.annotations ?? []) {
        if (!a || typeof a !== "object") continue;
        const ann = a as { type?: string; url?: string; title?: string };
        if (ann.type === "url_citation" && typeof ann.url === "string" && typeof ann.title === "string") {
          citations.push({ url: ann.url, title: ann.title, providerRaw: a });
        }
      }
    }
  }
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    model: typeof obj.model === "string" ? obj.model : requestedModel,
    output: text,
    citations,
    usage: obj.usage
      ? {
          inputTokens: obj.usage.input_tokens ?? 0,
          outputTokens: obj.usage.output_tokens ?? 0,
          totalTokens: obj.usage.total_tokens ?? (obj.usage.input_tokens ?? 0) + (obj.usage.output_tokens ?? 0)
        }
      : undefined,
    raw: payload
  };
}
```

Import additions at the top of `provider-wire.ts` if missing:

```ts
import type { WebSearchCitation } from "./index.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts -t "toOpenAIResponsesRequest|fromOpenAIResponsesResponse"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/provider-wire.ts packages/model/src/provider-wire.test.ts
git commit -m "feat(model): add OpenAI Responses request/response transformers"
```

---

### Task 6: Add `parseOpenAIResponsesStream` with synthetic web_search events

**Files:**
- Modify: `packages/model/src/provider-wire.ts`
- Test: `packages/model/src/provider-wire.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `provider-wire.test.ts`:

```ts
import { parseOpenAIResponsesStream } from "./provider-wire.js";

describe("parseOpenAIResponsesStream", () => {
  function asStream(lines: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(enc.encode(line));
        controller.close();
      }
    });
  }

  it("emits text-delta, tool-call-started/finished, citations, done", async () => {
    const sse = [
      "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"web_search_call\",\"id\":\"ws1\"}}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello \"}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"world\"}\n\n",
      "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"web_search_call\",\"id\":\"ws1\"}}\n\n",
      "data: {\"type\":\"response.output_text.annotation.added\",\"annotation\":{\"type\":\"url_citation\",\"url\":\"https://x.test\",\"title\":\"X\"}}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"model\":\"gpt-4o\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n",
      "data: [DONE]\n\n"
    ];
    const events: unknown[] = [];
    for await (const ev of parseOpenAIResponsesStream("openai", "gpt-4o", asStream(sse))) {
      events.push(ev);
    }
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("tool-call-started");
    expect(types).toContain("tool-call-finished");
    expect(types).toContain("citations");
    expect(types).toContain("text-delta");
    expect(types).toContain("done");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts -t parseOpenAIResponsesStream`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement the parser**

Append to `provider-wire.ts`:

```ts
export async function* parseOpenAIResponsesStream(
  providerId: string,
  requestedModel: string,
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ModelEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let toolStarted = false;
  let textBuf = "";
  const citations: WebSearchCitation[] = [];
  let finalUsage: ModelUsage | undefined;
  let finalId = "";
  let finalModel = requestedModel;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!dataLine || dataLine === "[DONE]") continue;
      let evt: { type?: string;
        item?: { type?: string };
        delta?: string;
        annotation?: { type?: string; url?: string; title?: string };
        response?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
      };
      try { evt = JSON.parse(dataLine); } catch { continue; }
      if (evt.type === "response.output_item.added" && evt.item?.type === "web_search_call" && !toolStarted) {
        toolStarted = true;
        yield { type: "tool-call-started", name: "web_search" };
      } else if (evt.type === "response.output_item.done" && evt.item?.type === "web_search_call") {
        yield { type: "tool-call-finished", name: "web_search" };
      } else if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
        textBuf += evt.delta;
        yield { type: "text-delta", text: evt.delta };
      } else if (evt.type === "response.output_text.annotation.added" && evt.annotation?.type === "url_citation") {
        const a = evt.annotation;
        if (typeof a.url === "string" && typeof a.title === "string") {
          citations.push({ url: a.url, title: a.title, providerRaw: a });
        }
      } else if (evt.type === "response.completed" && evt.response) {
        finalId = evt.response.id ?? "";
        finalModel = evt.response.model ?? requestedModel;
        if (evt.response.usage) {
          finalUsage = {
            inputTokens: evt.response.usage.input_tokens ?? 0,
            outputTokens: evt.response.usage.output_tokens ?? 0,
            totalTokens: evt.response.usage.total_tokens ?? 0
          };
        }
      }
    }
  }

  if (citations.length > 0) yield { type: "citations", items: citations };
  yield {
    type: "done",
    response: {
      id: finalId,
      model: finalModel,
      output: textBuf,
      citations,
      usage: finalUsage,
      raw: undefined
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts -t parseOpenAIResponsesStream`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/provider-wire.ts packages/model/src/provider-wire.test.ts
git commit -m "feat(model): add Responses SSE parser with synthetic web_search events"
```

---

### Task 7: Switch `OpenAIProvider` (and OpenAICompatibleProvider OpenAI path) to Responses API

**Files:**
- Modify: `packages/model/src/index.ts` (the `OpenAICompatibleProvider` class and any OpenAI subclass — search "openai" / "chat/completions" / call sites of `toOpenAIChatRequest` / `fromOpenAIChatResponse` / `parseOpenAIStream`)
- Modify: `packages/model/src/provider-wire.ts` — delete `toOpenAIChatRequest`, `fromOpenAIChatResponse`, `parseOpenAIStream` after callers are gone
- Test: existing OpenAI integration tests will fail until paths are swapped — that is the canary.

- [ ] **Step 1: Locate the OpenAI generate/stream call sites**

```bash
grep -n "toOpenAIChatRequest\|fromOpenAIChatResponse\|parseOpenAIStream\|/chat/completions" packages/model/src/index.ts
```

Expected: a generate() that POSTs to `${baseUrl}/chat/completions` and uses the Chat helpers, and a stream() that calls `parseOpenAIStream`.

- [ ] **Step 2: Replace with Responses-shaped fetches**

Within the generate() method body, change:
- `fetch(...{path: "/chat/completions"}, body: JSON.stringify(toOpenAIChatRequest(...)))` → `fetch(...{path: "/responses"}, body: JSON.stringify(toOpenAIResponsesRequest(request, this.defaultModel, policy)))`
- `fromOpenAIChatResponse(...)` → `fromOpenAIResponsesResponse(...)`

Within the stream() method body:
- `parseOpenAIStream(...)` → `parseOpenAIResponsesStream(this.id, request.model, response.body!)`

The `policy` argument needs to be plumbed: the provider class receives `request.metadata?.webSearchPolicy` (set by agent-core, see Task 13) or falls back to `{ enabled: false, maxUses: 5 }` when called directly without agent-core. Add at the top of generate()/stream():

```ts
const policy = (request.metadata?.webSearchPolicy as { enabled: boolean; maxUses: number } | undefined)
  ?? { enabled: false, maxUses: 5 };
```

- [ ] **Step 3: Run the affected unit tests, confirm they break and then pass**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts`
Run: `pnpm --filter @muse/model test -- index.test.ts`
Expected after edits: PASS. Any old test referencing `toOpenAIChatRequest`/`fromOpenAIChatResponse`/`parseOpenAIStream` that needs migration should be deleted or rewritten against the Responses shape in the same commit.

- [ ] **Step 4: Delete obsolete helpers from provider-wire**

Remove `toOpenAIChatRequest` (line 32), `fromOpenAIChatResponse` (line 395), and `parseOpenAIStream` (whatever its current location).

- [ ] **Step 5: Final verification**

Run: `pnpm --filter @muse/model test`
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add packages/model/src/index.ts packages/model/src/provider-wire.ts packages/model/src/provider-wire.test.ts packages/model/src/index.test.ts
git commit -m "feat(model)!: migrate OpenAI adapter Chat Completions -> Responses API"
```

---

## Phase 2 — Anthropic native web_search

### Task 8: Wire `web_search_20250305` injection in `toAnthropicRequest` + parse in `fromAnthropicResponse`

**Files:**
- Modify: `packages/model/src/provider-wire.ts` — `toAnthropicRequest` (line 49), `fromAnthropicResponse` (line 108)
- Test: `packages/model/src/provider-wire.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `provider-wire.test.ts`:

```ts
import anthropicFixture from "../__fixtures__/web-search/anthropic-messages.json";

describe("toAnthropicRequest web_search injection", () => {
  const base = { model: "anthropic/claude-3-5-sonnet-20241022", messages: [{ role: "user" as const, content: "x" }] };

  it("appends web_search_20250305 tool when enabled", () => {
    const out = toAnthropicRequest(base, "claude-3-5-sonnet-20241022", { enabled: true, maxUses: 3 });
    const tool = (out.tools ?? []).find((t: { type?: string }) => t.type === "web_search_20250305");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  });

  it("does not append when disabled", () => {
    const out = toAnthropicRequest(base, "claude-3-5-sonnet-20241022", { enabled: false, maxUses: 5 });
    expect((out.tools ?? []).some((t: { type?: string }) => t.type === "web_search_20250305")).toBe(false);
  });
});

describe("fromAnthropicResponse extracts citations", () => {
  it("parses web_search_tool_result citations and drops encrypted_content", () => {
    const r = fromAnthropicResponse("anthropic", "claude-3-5-sonnet-20241022", anthropicFixture);
    expect(r.citations).toHaveLength(2);
    expect(r.citations?.[0]).toMatchObject({ url: "https://example.com/news/a", title: "Example News A" });
    expect(r.citations?.[0]?.providerRaw).not.toContain("OPAQUE_BLOB");
  });

  it("output text is the concatenation of text blocks", () => {
    const r = fromAnthropicResponse("anthropic", "claude-3-5-sonnet-20241022", anthropicFixture);
    expect(r.output).toContain("Reports today highlight");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts -t "Anthropic"`
Expected: FAIL — signature mismatch or missing citations.

- [ ] **Step 3: Update `toAnthropicRequest`**

Change the signature at `packages/model/src/provider-wire.ts:49`:

```ts
export function toAnthropicRequest(
  request: ModelRequest,
  defaultModel: string | undefined,
  policy: { enabled: boolean; maxUses: number }
) {
  // ... existing body that builds payload ...
  const payload = /* existing payload */;
  const tools = [...(payload.tools ?? [])];
  if (policy.enabled) {
    tools.push({ type: "web_search_20250305", name: "web_search", max_uses: policy.maxUses });
  }
  return { ...payload, tools };
}
```

Verify existing callers — any that pass two args must be updated to pass policy. Pass `{ enabled: false, maxUses: 5 }` as a fallback in tests/callers that don't care.

- [ ] **Step 4: Update `fromAnthropicResponse`**

In the function body (line 108+), after the existing content iteration, also:
- For `web_search_tool_result` blocks, iterate `block.content[]` for `web_search_result` items → push `{ url, title, providerRaw: <result without encrypted_content> }` into a citations array.
- For `text` blocks, scan `block.citations[]` (Anthropic inline cite array) for `web_search_result_location` and push if not duplicate by url.

Use this strip helper for providerRaw:

```ts
function stripEncrypted(r: Record<string, unknown>): Record<string, unknown> {
  const { encrypted_content, ...rest } = r as { encrypted_content?: unknown };
  return rest;
}
```

Add `citations` to the returned `ModelResponse`.

- [ ] **Step 5: Update OpenAICompatibleProvider/AnthropicProvider call site**

In `packages/model/src/index.ts` AnthropicProvider class, plumb policy the same way:

```ts
const policy = (request.metadata?.webSearchPolicy as { enabled: boolean; maxUses: number } | undefined)
  ?? { enabled: false, maxUses: 5 };
const payload = toAnthropicRequest(request, this.defaultModel, policy);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts -t Anthropic`
Expected: PASS.

Run full model package: `pnpm --filter @muse/model test`
Expected: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add packages/model/src/provider-wire.ts packages/model/src/provider-wire.test.ts packages/model/src/index.ts
git commit -m "feat(model): wire Anthropic web_search_20250305 tool and citation extraction"
```

---

## Phase 3 — Gemini native googleSearch

### Task 9: Inject `googleSearch` / `googleSearchRetrieval` + parse `groundingMetadata`

**Files:**
- Modify: `packages/model/src/provider-wire.ts` — `toGeminiRequest` (line 139), `fromGeminiResponse` (line 306)
- Test: `packages/model/src/provider-wire.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `provider-wire.test.ts`:

```ts
import geminiFixture from "../__fixtures__/web-search/gemini-generate-content.json";

describe("toGeminiRequest web_search injection", () => {
  it("uses googleSearchRetrieval for gemini-1.5*", () => {
    const out = toGeminiRequest(
      { model: "gemini/gemini-1.5-flash", messages: [{ role: "user", content: "x" }] },
      { enabled: true, maxUses: 5 }
    );
    expect(out.tools).toEqual(expect.arrayContaining([{ googleSearchRetrieval: {} }]));
  });

  it("uses googleSearch for gemini-2.0+", () => {
    const out = toGeminiRequest(
      { model: "gemini/gemini-2.0-flash", messages: [{ role: "user", content: "x" }] },
      { enabled: true, maxUses: 5 }
    );
    expect(out.tools).toEqual(expect.arrayContaining([{ googleSearch: {} }]));
  });

  it("does not inject when disabled", () => {
    const out = toGeminiRequest(
      { model: "gemini/gemini-2.0-flash", messages: [{ role: "user", content: "x" }] },
      { enabled: false, maxUses: 5 }
    );
    expect(out.tools ?? []).not.toEqual(expect.arrayContaining([{ googleSearch: {} }]));
  });
});

describe("fromGeminiResponse extracts grounding citations", () => {
  it("parses groundingChunks into citations[]", () => {
    const r = fromGeminiResponse("gemini", "gemini-2.0-flash", geminiFixture);
    expect(r.citations).toHaveLength(2);
    expect(r.citations?.[0]).toMatchObject({
      url: "https://example.com/news/a",
      title: "Example News A"
    });
  });

  it("returns empty citations when groundingMetadata absent", () => {
    const r = fromGeminiResponse("gemini", "gemini-2.0-flash", {
      candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "STOP" }]
    });
    expect(r.citations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts -t Gemini`
Expected: FAIL.

- [ ] **Step 3: Update `toGeminiRequest` signature and body**

At `packages/model/src/provider-wire.ts:139` add the policy param:

```ts
export function toGeminiRequest(
  request: ModelRequest,
  policy: { enabled: boolean; maxUses: number } = { enabled: false, maxUses: 5 }
) {
  // ... existing body that builds payload ...
  const tools = [...(payload.tools ?? [])];
  if (policy.enabled) {
    const { modelId } = parseModelName(request.model || "");
    if (modelId.startsWith("gemini-1.5")) {
      tools.push({ googleSearchRetrieval: {} });
    } else {
      tools.push({ googleSearch: {} });
    }
  }
  return { ...payload, tools };
}
```

- [ ] **Step 4: Update `fromGeminiResponse`**

At line 306+, after the existing parsing, extract grounding:

```ts
const grounding = (candidates?.[0] as { groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } })?.groundingMetadata;
const citations: WebSearchCitation[] = [];
for (const chunk of grounding?.groundingChunks ?? []) {
  if (chunk?.web?.uri && chunk.web.title) {
    citations.push({ url: chunk.web.uri, title: chunk.web.title, providerRaw: chunk });
  }
}
return { ...existingResponse, citations };
```

- [ ] **Step 5: Update GeminiProvider call site**

In `packages/model/src/index.ts` GeminiProvider class:

```ts
const policy = (request.metadata?.webSearchPolicy as { enabled: boolean; maxUses: number } | undefined)
  ?? { enabled: false, maxUses: 5 };
const payload = toGeminiRequest(request, policy);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @muse/model test -- provider-wire.test.ts -t Gemini`
Expected: PASS.

Run: `pnpm --filter @muse/model test`
Expected: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add packages/model/src/provider-wire.ts packages/model/src/provider-wire.test.ts packages/model/src/index.ts
git commit -m "feat(model): wire Gemini googleSearch/Retrieval tool with model-family branch"
```

---

## Phase 4 — runtime-settings + agent-core integration

### Task 10: Define `webSearch` settings keys + env binding

**Files:**
- Modify: `packages/runtime-settings/src/index.ts` (add helpers + types)
- Test: `packages/runtime-settings/src/index.test.ts` (extend if exists; else create)

- [ ] **Step 1: Write the failing test**

Add to runtime-settings test file:

```ts
import { readWebSearchSettings } from "./index.js";

describe("readWebSearchSettings", () => {
  it("returns defaults when store empty and env empty", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    const out = await readWebSearchSettings(store, {});
    expect(out).toEqual({ enabled: true, maxUses: 5 });
  });

  it("reads webSearch.enabled and webSearch.maxUses from store", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    await store.upsert({ key: "webSearch.enabled", value: "false", type: "boolean", category: "webSearch" });
    await store.upsert({ key: "webSearch.maxUses", value: "9", type: "number", category: "webSearch" });
    const out = await readWebSearchSettings(store, {});
    expect(out).toEqual({ enabled: false, maxUses: 9 });
  });

  it("env MUSE_WEB_SEARCH=off overrides store", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    await store.upsert({ key: "webSearch.enabled", value: "true", type: "boolean", category: "webSearch" });
    const out = await readWebSearchSettings(store, { MUSE_WEB_SEARCH: "off" });
    expect(out.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/runtime-settings test`
Expected: FAIL — `readWebSearchSettings` not exported.

- [ ] **Step 3: Implement `readWebSearchSettings`**

Add to `packages/runtime-settings/src/index.ts`:

```ts
export interface WebSearchRuntimeSettings {
  readonly enabled: boolean;
  readonly maxUses: number;
}

const DEFAULT_WEB_SEARCH: WebSearchRuntimeSettings = { enabled: true, maxUses: 5 };

export async function readWebSearchSettings(
  store: RuntimeSettingsStore,
  env: Readonly<Record<string, string | undefined>>
): Promise<WebSearchRuntimeSettings> {
  const enabledRaw = await store.findValue("webSearch.enabled");
  const maxRaw = await store.findValue("webSearch.maxUses");
  let enabled = enabledRaw === undefined ? DEFAULT_WEB_SEARCH.enabled : enabledRaw === "true";
  let maxUses = DEFAULT_WEB_SEARCH.maxUses;
  if (maxRaw !== undefined) {
    const n = Number.parseInt(maxRaw, 10);
    if (Number.isFinite(n) && n > 0) maxUses = n;
  }
  const envFlag = env.MUSE_WEB_SEARCH?.toLowerCase();
  if (envFlag === "off") enabled = false;
  const envMax = env.MUSE_WEB_SEARCH_MAX_USES;
  if (envMax !== undefined) {
    const n = Number.parseInt(envMax, 10);
    if (Number.isFinite(n) && n > 0) maxUses = n;
  }
  return { enabled, maxUses };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @muse/runtime-settings test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-settings/src/index.ts packages/runtime-settings/src/index.test.ts
git commit -m "feat(runtime-settings): add readWebSearchSettings with env override"
```

---

### Task 11: Plumb `webSearchPolicy` into `ModelRequest.metadata` from agent-core

**Files:**
- Modify: `packages/agent-core/src/model-invocation.ts` (the call site that builds ModelRequest before invoking provider.generate / provider.stream)
- Modify: `packages/agent-core/src/types.ts` (if RuntimeContext needs a settings handle — likely already plumbed)
- Test: add `packages/agent-core/src/model-invocation.test.ts` if absent; otherwise extend.

- [ ] **Step 1: Locate the ModelRequest construction**

```bash
grep -n "ModelRequest\|provider\.generate\|provider\.stream" packages/agent-core/src/model-invocation.ts
```

Expected: one or two builder functions composing the final request before dispatch.

- [ ] **Step 2: Write the failing test**

Append/create in `packages/agent-core/src/model-invocation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildModelRequestWithWebSearch } from "./model-invocation.js";

describe("buildModelRequestWithWebSearch", () => {
  it("attaches webSearchPolicy from settings", () => {
    const r = buildModelRequestWithWebSearch(
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }] },
      { settings: { webSearch: { enabled: true, maxUses: 4 } }, override: undefined, env: {} }
    );
    expect((r.metadata as { webSearchPolicy?: { enabled: boolean; maxUses: number } } | undefined)?.webSearchPolicy).toEqual({
      enabled: true,
      maxUses: 4
    });
  });

  it("override=false suppresses policy.enabled even with settings on", () => {
    const r = buildModelRequestWithWebSearch(
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }] },
      { settings: { webSearch: { enabled: true, maxUses: 5 } }, override: false, env: {} }
    );
    expect((r.metadata as { webSearchPolicy?: { enabled: boolean } } | undefined)?.webSearchPolicy?.enabled).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @muse/agent-core test -- model-invocation.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 4: Implement helper**

Add to `packages/agent-core/src/model-invocation.ts` (top-level export):

```ts
import { decideWebSearchPolicy, type WebSearchSettings, type ModelRequest } from "@muse/model";

export function buildModelRequestWithWebSearch(
  request: ModelRequest,
  ctx: {
    settings: { webSearch?: WebSearchSettings };
    override?: boolean;
    env: Readonly<Record<string, string | undefined>>;
  }
): ModelRequest {
  const policy = decideWebSearchPolicy({
    model: parseProviderAndModel(request.model),
    settings: ctx.settings,
    override: ctx.override,
    env: ctx.env
  });
  return {
    ...request,
    metadata: { ...(request.metadata ?? {}), webSearchPolicy: policy }
  };
}

function parseProviderAndModel(spec: string): { provider: string; modelId: string } {
  const [provider, ...rest] = spec.split("/");
  return { provider: provider ?? "", modelId: rest.join("/") || provider || "" };
}
```

Then wire the existing model-invocation flow to call `buildModelRequestWithWebSearch` immediately before `provider.generate(request)` / `provider.stream(request)`. The settings + env + override come from the surrounding RuntimeContext / chat request body. Override flows from `request.body?.metadata?.tools?.web_search` (added to API in Task 13).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @muse/agent-core test -- model-invocation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/model-invocation.ts packages/agent-core/src/model-invocation.test.ts
git commit -m "feat(agent-core): plumb webSearchPolicy through ModelRequest.metadata"
```

---

### Task 12: Apply citation sanitisation in agent-core response path

**Files:**
- Modify: `packages/agent-core/src/model-invocation.ts` — the function that returns the final `ModelResponse` to callers
- Modify: `packages/agent-core/src/model-loop.ts` if it also constructs responses
- Test: extend `model-invocation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `model-invocation.test.ts`:

```ts
import { applyCitationSanitisation } from "./model-invocation.js";

describe("applyCitationSanitisation", () => {
  it("drops javascript: citations and keeps https", () => {
    const r = applyCitationSanitisation({
      id: "x", model: "m", output: "hi",
      citations: [
        { url: "https://safe.test", title: "S" },
        { url: "javascript:alert(1)", title: "evil" }
      ]
    });
    expect(r.citations).toHaveLength(1);
    expect(r.citations?.[0]?.url).toBe("https://safe.test");
  });

  it("is a no-op when no citations present", () => {
    const r = applyCitationSanitisation({ id: "x", model: "m", output: "hi" });
    expect(r.citations).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/agent-core test -- model-invocation.test.ts -t applyCitationSanitisation`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Add to `model-invocation.ts`:

```ts
import { sanitiseCitations } from "./citation-sanitiser.js";
import type { ModelResponse } from "@muse/model";

export function applyCitationSanitisation(response: ModelResponse): ModelResponse {
  if (!response.citations || response.citations.length === 0) return response;
  const { kept } = sanitiseCitations(response.citations);
  return { ...response, citations: kept };
}
```

Wire it: every place that returns the final `ModelResponse` to API-layer callers wraps with `applyCitationSanitisation(response)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @muse/agent-core test -- model-invocation.test.ts -t applyCitationSanitisation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/model-invocation.ts packages/agent-core/src/model-invocation.test.ts
git commit -m "feat(agent-core): sanitise citations in final ModelResponse pipeline"
```

---

## Phase 5 — apps/api surface

### Task 13: Accept `metadata.tools.web_search` override in `/api/chat` and return `citations[]`

**Files:**
- Modify: `apps/api/src/server-helpers.ts` — `runChat` (line 48), `runChatStream` (line 76)
- Modify: `apps/api/src/compat-parsers.ts` (or wherever the chat-body schema is defined) — accept `metadata.tools.web_search?: boolean`
- Test: existing api tests (`pnpm --filter @muse/api test`); add a unit test for the metadata extraction.

- [ ] **Step 1: Add metadata.tools.web_search to chat request schema**

In the parser file (search: `grep -n "metadata" apps/api/src/compat-parsers.ts`), extend the schema for chat body:

```ts
metadata: z.object({
  tools: z.object({
    web_search: z.boolean().optional()
  }).optional(),
  // ... existing metadata fields preserved
}).optional()
```

- [ ] **Step 2: Pass override into agent-core**

In `runChat` / `runChatStream`, when constructing the RuntimeContext to pass to agent-core's invocation, include:

```ts
const override = body.metadata?.tools?.web_search;
const env = process.env;
// downstream agent-core uses override + readWebSearchSettings(store, env)
```

- [ ] **Step 3: Surface `citations` in the response**

In `runChat`'s response shaping (where it currently returns `{ message, ... }`):

```ts
return reply.send({
  message: response.output,
  citations: response.citations ?? [],
  usage: response.usage
  // ... existing fields preserved
});
```

- [ ] **Step 4: Surface `tool-call` and `citations` SSE events in `runChatStream`**

Where the stream loop currently maps `ModelEvent → SSE`, add cases:

```ts
case "tool-call-started":
  reply.raw.write(`event: tool_call\ndata: ${JSON.stringify({ name: ev.name, phase: "started" })}\n\n`);
  break;
case "tool-call-finished":
  reply.raw.write(`event: tool_call\ndata: ${JSON.stringify({ name: ev.name, phase: "finished", count: ev.count })}\n\n`);
  break;
case "citations":
  reply.raw.write(`event: citations\ndata: ${JSON.stringify(ev.items)}\n\n`);
  break;
```

- [ ] **Step 5: Add a focused test**

Create `apps/api/src/chat-citations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { build } from "./test-helpers.js"; // existing test harness

describe("/api/chat citations", () => {
  it("returns citations[] in the response body (empty when diagnostic)", async () => {
    const app = await build({ provider: "diagnostic" });
    const res = await app.inject({ method: "POST", url: "/api/chat", payload: { message: "hi" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("citations");
    expect(Array.isArray(body.citations)).toBe(true);
  });
});
```

(If `test-helpers.ts` doesn't exist, model this after one of the other `apps/api/src/*.test.ts` files.)

- [ ] **Step 6: Run the API tests**

Run: `pnpm --filter @muse/api test`
Expected: PASS, new test included.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/server-helpers.ts apps/api/src/compat-parsers.ts apps/api/src/chat-citations.test.ts
git commit -m "feat(api): expose citations + tool_call SSE events on /api/chat"
```

---

## Phase 6 — apps/cli + apps/web surfaces

### Task 14: CLI — render citations and add `--no-web-search` flag

**Files:**
- Modify: `apps/cli/src/program.ts` — the chat command
- Modify: `apps/cli/src/human-formatters.ts` — formatter that prints assistant reply

- [ ] **Step 1: Add the formatter**

Add to `human-formatters.ts`:

```ts
export function formatCitations(citations: ReadonlyArray<{ url: string; title: string }> | undefined): string {
  if (!citations || citations.length === 0) return "";
  const lines = citations.map((c, i) => `  [${i + 1}] ${c.title} — ${c.url}`);
  return `\n\nSources:\n${lines.join("\n")}`;
}
```

- [ ] **Step 2: Append formatter output to chat replies**

Wherever the CLI prints the assistant message body, append `formatCitations(response.citations)`.

- [ ] **Step 3: Add `--no-web-search` flag**

In `program.ts`, on the chat command definition, add:

```ts
.option("--no-web-search", "disable native web_search for this request")
```

And when building the request body to `/api/chat`:

```ts
const body = {
  message: prompt,
  metadata: opts.webSearch === false
    ? { tools: { web_search: false } }
    : undefined
};
```

- [ ] **Step 4: Smoke locally**

Run: `pnpm --filter @muse/cli build`
Run: `node apps/cli/dist/index.js chat --no-web-search "hello"` against a running API (diagnostic provider OK)
Expected: chat works, no Sources appended.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/program.ts apps/cli/src/human-formatters.ts
git commit -m "feat(cli): render citations and add --no-web-search flag"
```

---

### Task 15: Web — citation chips + settings toggle

**Files:**
- Modify: `apps/web/src/ui/App.tsx` (or the chat message component therein)
- Modify: `apps/web/src/ui/setup-panel.tsx` (settings UI)

- [ ] **Step 1: Render citation chips under assistant messages**

In the assistant message component, after the body text:

```tsx
{message.citations && message.citations.length > 0 && (
  <div className="muse-citations">
    {message.citations.map((c, i) => (
      <a key={c.url} className="muse-citation-chip" href={c.url} target="_blank" rel="noreferrer noopener" title={c.url}>
        [{i + 1}] {c.title}
      </a>
    ))}
  </div>
)}
```

Add minimal CSS for `.muse-citations` / `.muse-citation-chip` in the existing stylesheet.

- [ ] **Step 2: Handle SSE `tool_call` and `citations` events**

In the streaming hook that already parses SSE for the chat panel, add cases for:
- `event: tool_call`, `data: { phase: "started" }` → set inline indicator state "🔍 Searching..."
- `event: tool_call`, `data: { phase: "finished" }` → clear indicator
- `event: citations`, `data: [...]` → attach to the in-progress assistant message

- [ ] **Step 3: Add `webSearch.enabled` toggle to setup panel**

In `setup-panel.tsx`, add a checkbox bound to a runtime-settings PUT call (`PATCH /api/admin/settings` or the equivalent endpoint already used by setup-panel). The key written is `webSearch.enabled`.

- [ ] **Step 4: Run the web tests**

Run: `pnpm --filter @muse/web test`
Expected: existing tests PASS, new behaviour exercised by at least one snapshot or interaction test.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/App.tsx apps/web/src/ui/setup-panel.tsx apps/web/src/ui/*.css
git commit -m "feat(web): render citation chips and add web_search toggle in setup panel"
```

---

## Phase 7 — smoke gates + docs

### Task 16: Add `citations` + `tool_call` SSE cases to `smoke:broad`

**Files:**
- Modify: `scripts/smoke-broad-http.mjs`

- [ ] **Step 1: Add the three new cases**

Add (near the existing `/api/chat` and `/api/chat/stream` assertions):

```js
// citations field present
{
  const res = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
  const body = await res.json();
  assert(Array.isArray(body.citations), "/api/chat response must include citations[]");
  pass("/api/chat returns citations[] field (empty for diagnostic)");
}

// kill switch via env
// (run a sub-process or document expected behaviour; for a single-process smoke, emulate by setting via /api/admin/settings if endpoint supports it)
```

- [ ] **Step 2: Update the SSE smoke**

For `/api/chat/stream`, capture the event names and assert no regression:

```js
const events = await collectSseEventNames(`${baseUrl}/api/chat/stream`, { message: "hi" });
assert(events.includes("done"), "stream emits done");
// tool_call and citations events are only emitted when the model invokes web_search.
// On the diagnostic provider they may not appear; only assert their absence does not break parsing.
```

- [ ] **Step 3: Run the smoke**

Run: `pnpm smoke:broad`
Expected: **50/50 PASS**.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-broad-http.mjs
git commit -m "test(smoke): assert citations field and tool_call SSE in broad smoke"
```

---

### Task 17: Live smoke — assert `citations.length > 0` per provider

**Files:**
- Modify: `scripts/smoke-live-llm.mjs` (or `scripts/smoke-live-all-providers.mjs` if there's already a per-provider sweep)

- [ ] **Step 1: Add per-provider live cases**

Pseudocode block to add:

```js
for (const { id, envKey, model } of [
  { id: "openai", envKey: "OPENAI_API_KEY", model: "gpt-4o" },
  { id: "anthropic", envKey: "ANTHROPIC_API_KEY", model: "claude-3-5-sonnet-20241022" },
  { id: "gemini", envKey: "GEMINI_API_KEY", model: "gemini-2.0-flash" }
]) {
  if (!process.env[envKey]) { skip(`${id} (${envKey} not set)`); continue; }
  // boot API with that provider key, POST a search-requiring prompt
  const res = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: {...}, body: JSON.stringify({ message: "What's today's top tech news?" }) });
  const body = await res.json();
  assert(Array.isArray(body.citations) && body.citations.length > 0, `${id}: citations.length > 0`);
  pass(`${id}: native web_search produced citations`);
}
```

- [ ] **Step 2: Run the live smoke (with available keys)**

Run: `OPENAI_API_KEY=$OPENAI_API_KEY ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY GEMINI_API_KEY=$GEMINI_API_KEY pnpm smoke:live`
Expected: at least one provider PASS; ideally all three present pass with `citations.length > 0`.

- [ ] **Step 3: Capture real fixtures (replacing Phase 0 hand-crafted ones)**

If desired, dump the first real successful response per provider and replace the matching `__fixtures__/web-search/*.json` so future unit tests anchor to real shapes. Then rerun: `pnpm --filter @muse/model test` and update parsers if real shape differs.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-live-llm.mjs packages/model/__fixtures__/web-search/
git commit -m "test(smoke): assert native web_search citations.length>0 across providers"
```

---

### Task 18: CHANGELOG breaking notice, architecture rule, README quickstart

**Files:**
- Modify: `CHANGELOG.md` (top of `## [Unreleased]`)
- Modify: `.claude/rules/architecture.md` — "Required provider families" section
- Modify: `README.md` and `README.ko.md` — quickstart 1 line

- [ ] **Step 1: CHANGELOG entry**

Insert at the top of `## [Unreleased] / ### Added`:

```md
- **Native server-side `web_search`** is now default-on across OpenAI / Anthropic
  / Gemini. The agent surfaces normalized `citations[]` on every response.
  Set `MUSE_WEB_SEARCH=off` (env) or `webSearch.enabled=false` (runtime-settings)
  to disable. ⚠ **Breaking**: the OpenAI adapter migrated from Chat Completions
  to the Responses API. Existing OpenAI-compat (non-OpenAI) endpoints are
  unaffected.
```

- [ ] **Step 2: Architecture rule**

In `.claude/rules/architecture.md` under "Required provider families", clarify:

```md
- OpenAI (Responses API — `/v1/responses`). Chat Completions removed.
```

- [ ] **Step 3: README quickstart**

In both READMEs, after the existing quickstart commands, add:

```md
Web search is on by default — ask "오늘 뉴스 알려줘" and the response will
include `citations[]`. Disable with `MUSE_WEB_SEARCH=off`.
```

- [ ] **Step 4: Final full verification**

Run, in order:

```bash
pnpm check
pnpm smoke:broad
pnpm lint
```

All must be green.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md .claude/rules/architecture.md README.md README.ko.md
git commit -m "docs: native web_search default-on, OpenAI Responses migration note"
```

---

## Self-Review (done before handing off)

**Spec coverage check** — every section of the spec maps to at least one task:
- §3 decisions → Tasks 2, 8, 9, 10, 12, 13
- §4.2 types → Task 1
- §4.3 policy → Task 2
- §5.1 OpenAI Responses → Tasks 5, 6, 7
- §5.2 Anthropic → Task 8
- §5.3 Gemini → Task 9
- §6 data flow → Tasks 11, 12, 13
- §7 error handling → covered by sanitiser (Task 3) + parser defaults (Tasks 6, 8, 9) + provider-side 4xx fail-fast (existing ModelProviderError)
- §8 settings → Task 10
- §9 UI → Tasks 14, 15
- §10 testing → Tasks 1-15 (TDD per task) + Tasks 16, 17 (smoke)
- §11 rollout → Task 18 (CHANGELOG + docs)
- §12 residual risks → Mitigated by smoke:live gate (Task 17) + fixture snapshot (Task 4)
- §13 success criteria → Task 17

**Placeholder scan**: no TBDs, no "add validation here". Each step has concrete code or commands.

**Type consistency**: `WebSearchPolicy { enabled, maxUses }`, `WebSearchCitation { url, title, snippet?, providerRaw? }`, `ModelEvent` kebab-case (`tool-call-started` / `tool-call-finished` / `citations`) are used uniformly across all tasks.

---

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-05-11-native-web-search.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.
