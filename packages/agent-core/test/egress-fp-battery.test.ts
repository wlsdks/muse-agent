import { describe, expect, it, vi } from "vitest";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { createToolExposureAuthority } from "@muse/policy";
import { authorizeEgress, createDefaultToolExposurePolicy, createEgressAuthority, ToolRegistry, type EgressAuthority, type MuseTool } from "@muse/tools";

import { createAgentRuntime } from "../src/index.js";

/**
 * AC16 — the FP battery: egress authorization (S5) must not be a shipped
 * regression that blocks legitimate browsing. This battery is MEASURED, not
 * merely asserted: it runs ≥20 realistic scenarios (including MODEL-RE-EMITTED
 * links — a page's prose is recorded, then a candidate URL derived from
 * reading that prose, in a form a real turn would plausibly produce, is
 * checked; a hand-copied identical string would prove nothing about the
 * normalization/extraction actually working) and reports the measured block
 * rate. Target 0 — a false positive here is a shipped regression, not a
 * security win (S5 v3 build contract).
 */

interface FpCase {
  readonly name: string;
  /** Returns true when the case's candidate URL was WRONGLY denied (a false positive). */
  isFalsePositive(): boolean;
}

function pureCase(name: string, setup: (authority: EgressAuthority) => string): FpCase {
  return {
    isFalsePositive() {
      const authority = createEgressAuthority();
      const candidate = setup(authority);
      const decision = authorizeEgress(candidate, authority);
      return decision.decision === "deny";
    },
    name
  };
}

const cases: FpCase[] = [
  // A) User-typed, various realistic phrasings.
  pureCase("user types a plain https URL in a sentence", (a) => {
    a.recordTrustedText("Can you check https://news.example/today for me?");
    return "https://news.example/today";
  }),
  pureCase("user types a bare origin only", (a) => {
    a.recordTrustedText("Open mysite.example please — https://mysite.example");
    return "https://mysite.example";
  }),
  pureCase("user types a URL with query params", (a) => {
    a.recordTrustedText("Look at https://shop.example/cart?id=42&qty=3");
    return "https://shop.example/cart?id=42&qty=3";
  }),
  pureCase("user types a URL with a path and trailing slash", (a) => {
    a.recordTrustedText("Go to https://docs.example/guide/setup/");
    return "https://docs.example/guide/setup/";
  }),
  pureCase("Korean-language sentence containing an embedded English URL", (a) => {
    a.recordTrustedText("이 사이트 확인해줘: https://korean-site.example/main 감사합니다");
    return "https://korean-site.example/main";
  }),
  // B) The user's OWN first-party stores (assembled into the system prompt / recall).
  pureCase("calendar event location URL (first-party, assembled system context)", (a) => {
    a.recordTrustedText("[Active Context] Upcoming event: Team sync at https://meet.example/room/42");
    return "https://meet.example/room/42";
  }),
  pureCase("notes containing a reference link (first-party recall)", (a) => {
    a.recordTrustedText("[Notes] Renewal portal: https://renew.example/account — due next month");
    return "https://renew.example/account";
  }),
  pureCase("contact record with a website field (first-party)", (a) => {
    a.recordTrustedText("[Contacts] Acme Corp — website https://acme.example/contact");
    return "https://acme.example/contact";
  }),
  // C) Model-re-emitted links from a page fetched THIS run — normalization must survive realistic
  // re-emission forms, not just a byte-identical hand-copy.
  pureCase("model re-emits a link exactly as read", (a) => {
    a.recordUntrustedText("Latest update posted at https://blog.example/2026/07/update — read more inside.");
    return "https://blog.example/2026/07/update";
  }),
  pureCase("model re-emits with different scheme/host CASE", (a) => {
    a.recordUntrustedText("See the announcement: https://Blog.Example/2026/07/update for details.");
    return "HTTPS://blog.example/2026/07/update";
  }),
  pureCase("model re-emits with an explicit default port added", (a) => {
    a.recordUntrustedText("Full text: https://blog.example/2026/07/update");
    return "https://blog.example:443/2026/07/update";
  }),
  pureCase("model re-emits with a trailing slash added vs bare page mention", (a) => {
    a.recordUntrustedText("Home page: https://portal.example");
    return "https://portal.example/";
  }),
  pureCase("model re-emits after the page's link was percent-encoded", (a) => {
    a.recordUntrustedText("Search results at https://search.example/find%3Fq%3Dopen%20house");
    return "https://search.example/find?q=open house";
  }),
  pureCase("model re-emits after the page rendered the link with HTML-entity-encoded ampersand", (a) => {
    a.recordUntrustedText("Report: https://data.example/report?year=2026&amp;month=7");
    return "https://data.example/report?year=2026&month=7";
  }),
  pureCase("model re-emits a link whose host has NFC/NFD unicode variance", (a) => {
    // Explicit codepoints (not a bare literal) so this stays a genuine NFC-vs-NFD
    // divergence regardless of what form an editor saves the character as: recorded
    // side is PRECOMPOSED (U+00E9, NFC), returned candidate is DECOMPOSED (e +
    // U+0301 combining acute accent, NFD) -- same character, two different byte forms.
    const nfcHost = "caf\u00e9.example";
    const nfdHost = "cafe\u0301.example";
    a.recordUntrustedText(`Cafe listing: https://${nfcHost}/menu`);
    return `https://${nfdHost}/menu`;
  }),
  pureCase("model re-emits the SAME page's link a second time (repeat mention, same host)", (a) => {
    a.recordUntrustedText("Details at https://news2.example/story — also see https://news2.example/story for the follow-up.");
    return "https://news2.example/story";
  }),
  // D) Bare-origin bootstrap from a TRUSTED (not untrusted) source.
  pureCase("bare origin bootstrap: user mentioned the full URL once, bare origin fetched later", (a) => {
    a.recordTrustedText("Their site is https://vendor.example/pricing — I use it a lot.");
    return "https://vendor.example";
  }),
  pureCase("bare origin bootstrap: calendar location gives the bare origin directly", (a) => {
    a.recordTrustedText("[Active Context] Event location: https://webinar.example");
    return "https://webinar.example";
  }),
  // E) Config-like trusted host (simulating what C3's allowlist plumbing will wire).
  {
    isFalsePositive() {
      const authority = createEgressAuthority();
      authority.recordTrustedHost("feeds.example");
      const decision = authorizeEgress("https://feeds.example", authority);
      return decision.decision === "deny";
    },
    name: "configured-allowlist host: bare origin of a directly-registered trusted host"
  },
  // F) Multi-mention conversational realism — a URL typed once, referenced again in later prose,
  // and TWO distinct links on the trusted-observed host both resolve without extra friction.
  pureCase("URL typed once, model re-issues it after a follow-up question later in the SAME trusted text", (a) => {
    a.recordTrustedText("Check https://tracker.example/issue/88. Any update on it? Let me know if issue/88 changed.");
    return "https://tracker.example/issue/88";
  }),
  pureCase("a second, different path on an already trusted-observed host", (a) => {
    a.recordTrustedText("My bank is https://mybank.example/login and my statements are at https://mybank.example/login");
    return "https://mybank.example/login";
  }),
  // G) Extraction/normalization symmetry — a URL containing ()[]{}'" must not be
  // false-denied by asymmetric mangling between the observed side and the candidate side.
  pureCase("a parenthesized Wikipedia-style URL typed by the user and re-emitted verbatim", (a) => {
    a.recordTrustedText("See https://en.wikipedia.org/wiki/Mercury_(planet) for the article.");
    return "https://en.wikipedia.org/wiki/Mercury_(planet)";
  }),
  pureCase("a URL with brackets in the path typed by the user and re-emitted verbatim", (a) => {
    a.recordTrustedText("Reference: https://docs.example/api/Array[index].html — see the note.");
    return "https://docs.example/api/Array[index].html";
  }),
  pureCase("a parenthesized URL mentioned in wrapping prose parens still resolves (outer parens are NOT part of the URL)", (a) => {
    a.recordTrustedText("Check the article (https://en.wikipedia.org/wiki/Mercury_(planet)) when you have time.");
    return "https://en.wikipedia.org/wiki/Mercury_(planet)";
  }),
  // H) Trusted-observed-host research flow — MORE than the fan-out cap's distinct URLs on a
  // single trusted-observed host must all resolve; the cap targets untrusted hosts only.
  {
    isFalsePositive() {
      const authority = createEgressAuthority({ fanOutCap: 3 });
      authority.recordTrustedHost("research.example");
      const urls = ["a", "b", "c", "d", "e"].map((slug) => `https://research.example/paper/${slug}`);
      authority.recordUntrustedText(`Related papers: ${urls.join(" ")}`);
      return urls.some((url) => authorizeEgress(url, authority).decision === "deny");
    },
    name: ">3 distinct URLs on a trusted-observed host are all exempt from the fan-out cap (research flow)"
  }
];

function sequenceProvider(responses: readonly ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    id: "test",
    async generate(request: ModelRequest) {
      const response = responses[Math.min(index, responses.length - 1)] ?? responses[responses.length - 1];
      index += 1;
      return { ...response, model: request.model } as ModelResponse;
    },
    async listModels() {
      return [];
    },
    async *stream() {}
  };
}

function fetchTool(name: string, spy: ReturnType<typeof vi.fn>, responsesByUrl: Record<string, string> = {}): MuseTool {
  return {
    definition: {
      description: `Fetch a URL (${name}).`,
      inputSchema: { properties: { url: { type: "string" } }, required: ["url"], type: "object" },
      name,
      risk: "read"
    },
    execute: (args) => {
      const url = (args as { url: string }).url;
      spy(url);
      return responsesByUrl[url] ?? `fetched ${url}`;
    }
  };
}

/** End-to-end (full AgentRuntime + model loop) model-re-emission cases — not just the pure module. */
async function runtimeFalsePositive(pageUrl: string, pageText: string, reemittedUrl: string): Promise<boolean> {
  const httpSpy = vi.fn();
  const runtime = createAgentRuntime({
    maxToolCalls: 6,
    modelProvider: sequenceProvider([
      { id: "t1", model: "test-model", output: "Checking.", toolCalls: [{ arguments: { url: pageUrl }, id: "tc-1", name: "browser_open" }] },
      { id: "t2", model: "test-model", output: "Following up.", toolCalls: [{ arguments: { url: reemittedUrl }, id: "tc-2", name: "browser_open" }] },
      { id: "final", model: "test-model", output: "Done." }
    ]),
    toolApprovalGate: () => ({ allowed: true }),
    toolExposurePolicy: createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true }),
    toolRegistry: new ToolRegistry([fetchTool("browser_open", httpSpy, { [pageUrl]: pageText })])
  });

  await runtime.run({
    messages: [{ content: `Check ${pageUrl} and follow anything relevant.`, role: "user" }],
    model: "provider/model",
    runId: "run-fp-e2e",
    toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["browser_open"], localMode: true })
  });

  // A false positive here is the re-emitted link's fetch NEVER happening (only the first fetch ran).
  return httpSpy.mock.calls.length < 2;
}

describe("AC16 — egress FP battery (MEASURED, target 0)", () => {
  it("reports the measured false-positive rate across realistic legitimate scenarios", async () => {
    const results = cases.map((c) => ({ falsePositive: c.isFalsePositive(), name: c.name }));

    // Two full end-to-end (real AgentRuntime + model loop) model-re-emission cases, folded into the
    // same measured battery — these prove the extraction/normalization survives the ACTUAL tool-call
    // pipeline, not just a direct authorizeEgress call.
    results.push({
      falsePositive: await runtimeFalsePositive(
        "https://e2e-portal.example/board",
        "Board notice — see the linked spec at https://e2e-portal.example/spec for details.",
        "https://e2e-portal.example/spec"
      ),
      name: "[e2e] model reads a page and re-issues its own link through the real tool-call pipeline"
    });
    results.push({
      falsePositive: await runtimeFalsePositive(
        "https://e2e-docs.example/index",
        "See also: https://e2e-docs.example/appendix?ref=1&note=ok for the appendix.",
        "https://e2e-docs.example/appendix?ref=1&note=ok"
      ),
      name: "[e2e] model re-issues a link carrying query params exactly as the page rendered them"
    });

    const total = results.length;
    const falsePositives = results.filter((r) => r.falsePositive);
    const rate = falsePositives.length / total;

    console.log(
      `[AC16 FP battery] ${total} cases, ${falsePositives.length} false positive(s), rate=${(rate * 100).toFixed(1)}%` +
        (falsePositives.length > 0 ? ` — FAILING: ${falsePositives.map((f) => f.name).join("; ")}` : "")
    );

    expect(total).toBeGreaterThanOrEqual(20);
    expect(rate).toBe(0);
  });
});
