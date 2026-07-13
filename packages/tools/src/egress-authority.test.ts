import { describe, expect, it } from "vitest";

import {
  authorizeEgress,
  authorizeEgressForValue,
  collectUrlsFromValue,
  createEgressAuthority,
  DEFAULT_EGRESS_FAN_OUT_CAP,
  extractUrlsFromText,
  normalizeEgressUrl
} from "./egress-authority.js";

describe("normalizeEgressUrl", () => {
  it("lowercases scheme + host and strips a default port", () => {
    expect(normalizeEgressUrl("HTTPS://Example.COM:443/Path")?.canonical).toBe("https://example.com/Path");
    expect(normalizeEgressUrl("http://example.com:80/x")?.canonical).toBe("http://example.com/x");
  });

  it("keeps a non-default port", () => {
    expect(normalizeEgressUrl("https://example.com:8443/x")?.canonical).toBe("https://example.com:8443/x");
  });

  it("collapses a bare trailing slash", () => {
    expect(normalizeEgressUrl("https://example.com/")?.canonical).toBe(normalizeEgressUrl("https://example.com")?.canonical);
  });

  it("strips a trailing dot on the host", () => {
    expect(normalizeEgressUrl("https://example.com./x")?.canonical).toBe("https://example.com/x");
  });

  it("HTML-entity decodes before comparing", () => {
    const a = normalizeEgressUrl("https://example.com/?a=1&amp;b=2")?.canonical;
    const b = normalizeEgressUrl("https://example.com/?a=1&b=2")?.canonical;
    expect(a).toBe(b);
  });

  it("percent-decodes before comparing (bounded, recursive)", () => {
    const encoded = normalizeEgressUrl("https://example.com/caf%2565")?.canonical; // %25 -> %, then %65 -> e
    expect(encoded).toBe("https://example.com/cafe");
  });

  it("is bounded against a pathological percent-decode loop (never hangs, never throws)", () => {
    // "%" repeated is not a valid escape at any round; must return, not throw.
    expect(() => normalizeEgressUrl("https://example.com/" + "%".repeat(50))).not.toThrow();
  });

  it("rejects a non-http(s)/ws(s) scheme", () => {
    expect(normalizeEgressUrl("ftp://example.com/x")).toBeNull();
    expect(normalizeEgressUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeEgressUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects unparseable garbage", () => {
    expect(normalizeEgressUrl("not a url at all")).toBeNull();
    expect(normalizeEgressUrl("")).toBeNull();
  });

  it("flags a bare origin (no query, no fragment, path <= '/')", () => {
    expect(normalizeEgressUrl("https://example.com")?.isBareOrigin).toBe(true);
    expect(normalizeEgressUrl("https://example.com/")?.isBareOrigin).toBe(true);
    expect(normalizeEgressUrl("https://example.com/path")?.isBareOrigin).toBe(false);
    expect(normalizeEgressUrl("https://example.com/?a=1")?.isBareOrigin).toBe(false);
    expect(normalizeEgressUrl("https://example.com/#frag")?.isBareOrigin).toBe(false);
  });
});

describe("extractUrlsFromText — URLs WITHIN prose, not just whole-string parses", () => {
  it("finds a URL embedded in a sentence", () => {
    expect(extractUrlsFromText("see https://example.com/x for details")).toEqual(["https://example.com/x"]);
  });

  it("strips trailing sentence punctuation", () => {
    expect(extractUrlsFromText("visit https://example.com/x.")).toEqual(["https://example.com/x"]);
    expect(extractUrlsFromText("(https://example.com/x)")).toEqual(["https://example.com/x"]);
  });

  it("finds multiple URLs", () => {
    expect(extractUrlsFromText("https://a.example/1 and https://b.example/2")).toEqual([
      "https://a.example/1",
      "https://b.example/2"
    ]);
  });

  it("does NOT match a URL-shaped word inside plain prose with no scheme", () => {
    expect(extractUrlsFromText("Baker Street is nice")).toEqual([]);
  });

  it("crucially does NOT match prose against a URL structurally — this is a text extractor, not a fuzzy matcher", () => {
    // '?d=Baker%20Street' in a note's plain-text mention must not be treated as a URL.
    expect(extractUrlsFromText("note: ?d=Baker%20Street")).toEqual([]);
  });
});

describe("collectUrlsFromValue — value-shape walk, not tool-name keyed", () => {
  it("finds a URL nested inside an object map (e.g. a headers arg)", () => {
    const urls = collectUrlsFromValue({ headers: { Referer: "https://evil.example/x" } });
    expect(urls).toEqual(["https://evil.example/x"]);
  });

  it("finds URLs nested inside an array (e.g. a form-fill fields arg)", () => {
    const urls = collectUrlsFromValue({ fields: [{ value: "https://a.example/1" }, { value: "plain text" }] });
    expect(urls).toEqual(["https://a.example/1"]);
  });

  it("returns empty for a value with no URL anywhere", () => {
    expect(collectUrlsFromValue({ a: 1, b: "hello", c: [true, null] })).toEqual([]);
  });

  it("does not stack-overflow on a deeply nested payload", () => {
    let value: unknown = "https://example.com/deep";
    for (let i = 0; i < 100; i += 1) {
      value = { nested: value };
    }
    expect(() => collectUrlsFromValue(value)).not.toThrow();
  });
});

describe("authorizeEgress — the allow/confirm/deny decision", () => {
  it("allows a URL quoted verbatim from a trusted source", () => {
    const authority = createEgressAuthority();
    authority.recordTrustedText("please open https://mysite.example/page");
    expect(authorizeEgress("https://mysite.example/page", authority).decision).toBe("allow");
  });

  it("denies a URL never observed anywhere (model-composed)", () => {
    const authority = createEgressAuthority();
    expect(authorizeEgress("https://evil.example/exfil?d=secret", authority).decision).toBe("deny");
  });

  it("denies a non-URL string outright", () => {
    const authority = createEgressAuthority();
    expect(authorizeEgress("just some text", authority).decision).toBe("deny");
  });

  it("confirms a link-followed URL under the fan-out cap", () => {
    const authority = createEgressAuthority();
    authority.recordUntrustedText("click https://attacker.example/link");
    expect(authorizeEgress("https://attacker.example/link", authority).decision).toBe("confirm");
  });

  it("allows a bare origin whose host is trusted-observed", () => {
    const authority = createEgressAuthority();
    authority.recordTrustedText("my bank is https://mybank.example/account");
    const result = authorizeEgress("https://mybank.example", authority);
    expect(result.decision).toBe("allow");
  });

  it("does NOT bootstrap a bare origin from an untrusted-only host (AC8)", () => {
    const authority = createEgressAuthority();
    authority.recordUntrustedText("see evil.example for more — https://evil.example/page");
    const result = authorizeEgress("https://evil.example", authority);
    expect(result.decision).not.toBe("allow");
  });

  it("compares URL-to-URL only — never URL-to-prose", () => {
    const authority = createEgressAuthority();
    // The note mentions an address in plain prose; a query string that happens
    // to embed similar words must NOT be treated as quoted from it.
    authority.recordTrustedText("Remember to visit 12 Baker Street tomorrow");
    const result = authorizeEgress("https://evil.example/collect?d=Baker%20Street", authority);
    expect(result.decision).toBe("deny");
  });

  it("is immune to base64-encoded payloads in the query — still a composed URL, still denied", () => {
    const authority = createEgressAuthority();
    const secretB64 = Buffer.from("super-secret-token").toString("base64");
    const result = authorizeEgress(`https://evil.example/x?d=${secretB64}`, authority);
    expect(result.decision).toBe("deny");
  });

  it("is immune to percent-encoded payloads in the query — still a composed URL, still denied", () => {
    const authority = createEgressAuthority();
    const encoded = encodeURIComponent("super-secret-token value with spaces");
    const result = authorizeEgress(`https://evil.example/x?d=${encoded}`, authority);
    expect(result.decision).toBe("deny");
  });

  describe("fan-out cap (CamoLeak dictionary control)", () => {
    it("denies beyond the cap for distinct untrusted-observed hosts", () => {
      const authority = createEgressAuthority({ fanOutCap: 3 });
      const decisions: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const host = `attacker${i.toString()}.example`;
        authority.recordUntrustedText(`link: https://${host}/x`);
        decisions.push(authorizeEgress(`https://${host}/x`, authority).decision);
      }
      expect(decisions.filter((d) => d === "confirm")).toHaveLength(3);
      expect(decisions.filter((d) => d === "deny")).toHaveLength(3);
    });

    it("distinct URLs on the SAME untrusted host EACH consume fan-out budget (CamoLeak same-origin dictionary)", () => {
      const authority = createEgressAuthority({ fanOutCap: 3 });
      const decisions: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const url = `https://attacker.example/leak?c=${String.fromCharCode(65 + i)}`;
        authority.recordUntrustedText(`link: ${url}`);
        decisions.push(authorizeEgress(url, authority).decision);
      }
      // The canonical CamoLeak attack is ONE origin with a dictionary of same-host
      // links — the cap MUST bite here, not just across distinct hosts.
      expect(decisions.slice(0, 3)).toEqual(["confirm", "confirm", "confirm"]);
      expect(decisions[3]).toBe("deny");
    });

    it("re-checking the SAME already-admitted URL does not re-consume budget", () => {
      const authority = createEgressAuthority({ fanOutCap: 1 });
      authority.recordUntrustedText("link: https://attacker.example/a");
      expect(authorizeEgress("https://attacker.example/a", authority).decision).toBe("confirm");
      expect(authorizeEgress("https://attacker.example/a", authority).decision).toBe("confirm");
      // A DIFFERENT URL — even on the same host — is now over budget.
      authority.recordUntrustedText("https://attacker.example/b");
      expect(authorizeEgress("https://attacker.example/b", authority).decision).toBe("deny");
    });

    it("a URL whose host is trusted-observed is exempt from the cap entirely", () => {
      const authority = createEgressAuthority({ fanOutCap: 1 });
      authority.recordTrustedHost("research.example");
      const urls = ["a", "b", "c", "d"].map((slug) => `https://research.example/paper/${slug}`);
      authority.recordUntrustedText(`Related papers: ${urls.join(" ")}`);
      for (const url of urls) {
        expect(authorizeEgress(url, authority).decision).toBe("confirm");
      }
    });

    it("default cap is 3", () => {
      expect(DEFAULT_EGRESS_FAN_OUT_CAP).toBe(3);
    });
  });
});

describe("authorizeEgressForValue — worst-of over every URL in a tool-call arg value", () => {
  it("returns undefined (no signal) when there is no URL at all — byte-identical control", () => {
    const authority = createEgressAuthority();
    expect(authorizeEgressForValue({ query: "look up the parking permit deadline" }, authority)).toBeUndefined();
  });

  it("denies the whole call when ANY nested URL is model-composed, even alongside a trusted one", () => {
    const authority = createEgressAuthority();
    authority.recordTrustedText("https://mysite.example/ok");
    const result = authorizeEgressForValue(
      { url: "https://mysite.example/ok", headers: { "X-Next": "https://evil.example/exfil" } },
      authority
    );
    expect(result?.decision).toBe("deny");
  });
});
