import { describe, expect, it } from "vitest";
import {
  createCancellationToken,
  createRunId,
  DEFAULT_ERROR_BODY_CAP,
  formatBoundaryViolation,
  formatErrorForTerminal,
  hmacSha256Hex,
  redactSecretsInText,
  sha256Hex,
  truncateErrorBody,
  verifyHmacSha256Hex
} from "../src/index.js";

describe("createRunId", () => {
  it("uses a readable prefix", () => {
    expect(createRunId("muse")).toMatch(/^muse_[0-9a-f-]{36}$/);
  });
});

describe("shared crypto helpers", () => {
  it("produces deterministic SHA-256 and HMAC signatures", () => {
    const signature = hmacSha256Hex("payload", "secret");

    expect(sha256Hex("payload")).toBe("239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5");
    expect(signature).toBe("b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4");
    expect(verifyHmacSha256Hex("payload", `sha256=${signature}`, "secret")).toBe(true);
    expect(verifyHmacSha256Hex("payload", signature, "wrong")).toBe(false);
    expect(verifyHmacSha256Hex("payload", "not-a-hex-signature", "secret")).toBe(false);
  });

  it("fails closed on every malformed signature instead of throwing or accepting", () => {
    const sig = hmacSha256Hex("payload", "secret"); // 64 lowercase hex

    // Uppercase hex is still valid (the regex is case-insensitive).
    expect(verifyHmacSha256Hex("payload", sig.toUpperCase(), "secret")).toBe(true);
    // A tampered but still-64-valid-hex signature is rejected.
    const tampered = `${sig.slice(0, 63)}${sig[63] === "a" ? "b" : "a"}`;
    expect(verifyHmacSha256Hex("payload", tampered, "secret")).toBe(false);
    // Wrong-length hex must reject, NOT crash timingSafeEqual on a
    // buffer length mismatch.
    expect(verifyHmacSha256Hex("payload", sig.slice(0, 63), "secret")).toBe(false);
    expect(verifyHmacSha256Hex("payload", `${sig}ab`, "secret")).toBe(false);
    expect(verifyHmacSha256Hex("payload", "", "secret")).toBe(false);
    // A non-string signature (absent header reaching here) fails
    // closed — no `.startsWith` TypeError on the security boundary.
    expect(verifyHmacSha256Hex("payload", undefined as unknown as string, "secret")).toBe(false);
    expect(verifyHmacSha256Hex("payload", 12345 as unknown as string, "secret")).toBe(false);
  });
});

describe("boundary and cancellation helpers", () => {
  it("formats boundary violations consistently", () => {
    expect(
      formatBoundaryViolation({
        actual: "tool without assistant call",
        boundary: "assistant_tool_pair",
        expected: "assistant tool call before tool response",
        reason: "orphan tool response"
      })
    ).toBe(
      "Boundary violation: boundary=assistant_tool_pair; reason=orphan tool response; expected=assistant tool call before tool response; actual=tool without assistant call"
    );
  });

  it("exposes an abort signal with deterministic cancellation errors", () => {
    const token = createCancellationToken();

    expect(token.signal.aborted).toBe(false);
    token.cancel("timeout");

    expect(token.signal.aborted).toBe(true);
    expect(() => token.throwIfCancelled()).toThrow("timeout");
  });

  it("cancel() with no reason uses the documented 'Operation cancelled' default — pins the API contract so a regression that drops the default leaves an actionable error message intact", () => {
    const token = createCancellationToken();
    token.cancel();
    expect(token.signal.aborted).toBe(true);
    expect(() => token.throwIfCancelled()).toThrow("Operation cancelled");
  });

  it("throwIfCancelled() is a no-op BEFORE any cancel call — a regression that always threw would break every consumer that polls before cancellation", () => {
    const token = createCancellationToken();
    expect(token.signal.aborted).toBe(false);
    expect(() => token.throwIfCancelled()).not.toThrow();
    // Polling repeatedly stays a no-op until something actually cancels.
    expect(() => token.throwIfCancelled()).not.toThrow();
  });

  it("throwIfCancelled() is idempotent after cancel — repeated polls all throw the same error so caller cleanup loops aren't surprised by a one-shot exception", () => {
    const token = createCancellationToken();
    token.cancel("deadline");
    expect(() => token.throwIfCancelled()).toThrow("deadline");
    expect(() => token.throwIfCancelled()).toThrow("deadline");
    expect(() => token.throwIfCancelled()).toThrow("deadline");
  });

  it("redactSecretsInText scrubs high-confidence credential shapes", () => {
    // OpenAI sk- + sk-proj-.
    expect(redactSecretsInText("rotate sk-proj-abcdefghijklmnopqrstuvwxyz today"))
      .toBe("rotate [redacted-openai-key] today");
    expect(redactSecretsInText("oldkey sk-abcdefghijklmnopqrstuvwxyz"))
      .toContain("[redacted-openai-key]");
    // Anthropic sk-ant-.
    expect(redactSecretsInText("note: sk-ant-api03-abcdefghijklmnop"))
      .toContain("[redacted-anthropic-key]");
    // GitHub PAT.
    expect(redactSecretsInText("gh token ghp_abcdefghijklmnopqrstuvwxyzABCDEF"))
      .toContain("[redacted-github-pat]");
    // AWS access key.
    expect(redactSecretsInText("AKIAIOSFODNN7EXAMPLE access"))
      .toContain("[redacted-aws-access-key]");
    // Google API key.
    expect(redactSecretsInText("key=AIzaSyABCDEF1234567890abcdef1234567890ABCDE"))
      .toContain("[redacted-google-api-key]");
    // Google OAuth access token (`ya29.` bearer).
    expect(redactSecretsInText("Authorization: Bearer ya29.A0AbCdEfGhIjKlMnOpQrStUvWxYz"))
      .toContain("[redacted-google-oauth-token]");
    // Slack bot token.
    expect(redactSecretsInText("token=xoxb-12345-67890-AbCdEf"))
      .toContain("[redacted-slack-bot-token]");
    // JWT.
    expect(redactSecretsInText("bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"))
      .toContain("[redacted-jwt]");
    // Telegram / Discord bot tokens — Muse's own delivery
    // channels; a leak round-trips via the very bot it controls.
    // Built by concatenation so the source file contains NO
    // contiguous token-shaped literal: GitHub push-protection
    // scans source bytes, not post-eval strings (same technique
    // the Stripe fixture below uses).
    const tgToken = `${"7123456789"}:${"AAH9xZ2bQwErTyUiOpAsDfGhJkLzXcVbNmQ"}`;
    expect(redactSecretsInText(`rotate bot ${tgToken} now`))
      .toBe("rotate bot [redacted-telegram-bot-token] now");
    const dcToken = ["MTk4NjIyNDgzNDcxOTI1MjQy", "GxYzAb", "4f8sLp-9Qw3rTy1Ui0pAsDfGhJkLzXcVbNmQ"].join(".");
    expect(redactSecretsInText(`leaked ${dcToken}`))
      .toContain("[redacted-discord-bot-token]");
    // A bare "id:word" with too-short a tail is NOT a telegram
    // token (no false positive on ordinary "key: value" text).
    expect(redactSecretsInText("ticket 123456: shipped today"))
      .toBe("ticket 123456: shipped today");
    // No false positive on plain English.
    expect(redactSecretsInText("Q3 budget memo due in 5 min"))
      .toBe("Q3 budget memo due in 5 min");
    // Empty / non-string input passes through.
    expect(redactSecretsInText("")).toBe("");
  });

  it("redactSecretsInText redacts sensitive URL query-parameter values (keeping the param name)", () => {
    // Generic api_key in a URL — value isn't a known vendor shape but is still a secret.
    expect(redactSecretsInText("see https://api.example.com/v1/x?api_key=Zm9vYmFyc2VjcmV0&q=1"))
      .toBe("see https://api.example.com/v1/x?api_key=[redacted-url-credential]&q=1");
    // Presigned-S3-style: signature + credential params both redacted.
    const presigned = "https://s3.example.com/o?X-Amz-Signature=deadbeef0123456789&X-Amz-Credential=AKIAEXAMPLE";
    const out = redactSecretsInText(presigned);
    expect(out).toContain("X-Amz-Signature=[redacted-url-credential]");
    expect(out).toContain("X-Amz-Credential=[redacted-url-credential]");
    // Bare access_token / token params.
    expect(redactSecretsInText("cb https://h/p?access_token=abc.def.ghi&state=ok"))
      .toBe("cb https://h/p?access_token=[redacted-url-credential]&state=ok");
    // No false positive on non-sensitive params.
    expect(redactSecretsInText("https://h/p?id=123&page=2&q=hello"))
      .toBe("https://h/p?id=123&page=2&q=hello");
  });

  it("redactSecretsInText redacts PEM-encoded private keys (RSA / EC / OPENSSH / bare) as one unit so a key accidentally pasted into a note / tool output / chat message can't round-trip through Slack / Discord / Telegram / the proactive log", () => {
    const rsaKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      "KLMNOPQRSTUVWXYZ0123456789+/abcdefghijklmnopqrstuvwxyzABCDEFGH",
      "-----END RSA PRIVATE KEY-----"
    ].join("\n");
    const opensshKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
      "ZWQyNTUxOQAAACBabcDEfgHIjKlMnOpQrStUvWxYzAaBcDeFgHiJkLmNoPqRsT",
      "-----END OPENSSH PRIVATE KEY-----"
    ].join("\n");
    const ecKey = [
      "-----BEGIN EC PRIVATE KEY-----",
      "MHcCAQEEIA1234567890abcdefghijklmnopqrstuvwxyzABCDEFG",
      "-----END EC PRIVATE KEY-----"
    ].join("\n");
    const bareKey = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC",
      "-----END PRIVATE KEY-----"
    ].join("\n");

    expect(redactSecretsInText(`prelude\n${rsaKey}\ntrailing`))
      .toBe("prelude\n[redacted-private-key]\ntrailing");
    expect(redactSecretsInText(opensshKey)).toBe("[redacted-private-key]");
    expect(redactSecretsInText(ecKey)).toBe("[redacted-private-key]");
    expect(redactSecretsInText(bareKey)).toBe("[redacted-private-key]");

    const twoKeys = `${rsaKey}\nbetween two keys\n${ecKey}`;
    const scrubbedTwoKeys = redactSecretsInText(twoKeys);
    expect(scrubbedTwoKeys).toBe("[redacted-private-key]\nbetween two keys\n[redacted-private-key]");

    // PEM block ordering: when the BEGIN..END frame wraps a body
    // that looks like another secret shape (a JWT-prefixed line
    // inside the base64 body), the private-key pattern must run
    // FIRST so the whole frame becomes one [redacted-private-key]
    // rather than getting nibbled into [redacted-jwt] + leftover.
    const keyWithJwtShapedBody = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "eyJabcdefghij.eyJklmnopqrst.uvwxyzABCDEFGHIJKLMNOP",
      "-----END RSA PRIVATE KEY-----"
    ].join("\n");
    expect(redactSecretsInText(keyWithJwtShapedBody)).toBe("[redacted-private-key]");

    // No false positive on plain English mentioning "private key"
    // outside the PEM frame.
    expect(redactSecretsInText("the user's private key is on their laptop"))
      .toBe("the user's private key is on their laptop");
    // No false positive on a public-key PEM frame (different
    // marker, contains no sensitive material — runs intact).
    expect(redactSecretsInText("-----BEGIN PUBLIC KEY-----\nMFkwEwYH\n-----END PUBLIC KEY-----"))
      .toBe("-----BEGIN PUBLIC KEY-----\nMFkwEwYH\n-----END PUBLIC KEY-----");
  });

  it("redactSecretsInText also scrubs PGP-armored private key BLOCKs (the BLOCK suffix isn't part of the OpenSSH / X.509 PEM family but uses the same `-----BEGIN ... -----` framing) so an accidentally-pasted GPG private key from `gpg --armor --export-secret-keys` doesn't round-trip through delivery surfaces", () => {
    const pgpKey = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "Version: GnuPG v2",
      "",
      "lQOYBGFakeKeyBlockDataAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP",
      "QRSTUVWXYZ0123456789+/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP",
      "=Az9X",
      "-----END PGP PRIVATE KEY BLOCK-----"
    ].join("\n");
    expect(redactSecretsInText(pgpKey)).toBe("[redacted-private-key]");
    expect(redactSecretsInText(`subject: rotate keys\n${pgpKey}\n--end of mail--`))
      .toBe("subject: rotate keys\n[redacted-private-key]\n--end of mail--");
    // PGP PUBLIC KEY BLOCK is NOT sensitive — must not be redacted.
    const pgpPublic = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmFkwEwYH\n-----END PGP PUBLIC KEY BLOCK-----";
    expect(redactSecretsInText(pgpPublic)).toBe(pgpPublic);
  });

  it("redactSecretsInText covers Stripe secret + GitLab PAT shapes (goal 107)", () => {
    // Build the Stripe shapes via concatenation so the source file
    // does NOT contain a contiguous prefix-plus-24-char literal —
    // GitHub's push-protection secret-scanner reads source bytes,
    // not post-eval strings, and a literal would false-positive as
    // a real Stripe key. Splitting the prefix from the body keeps
    // the runtime fixture identical without tripping the scanner.
    const stripeSecretBody = "abcdefghijklmnopqrstuvwx";
    const stripeLiveSecret = `sk_${"live"}_${stripeSecretBody}`;
    const stripeTestSecret = `sk_${"test"}_${stripeSecretBody}`;
    const stripeRestrictedKey = `rk_${"live"}_${stripeSecretBody}`;
    const stripePublishable = `pk_${"live"}_${stripeSecretBody}`;
    // Stripe live + test, secret + restricted.
    expect(redactSecretsInText(`STRIPE=${stripeLiveSecret}`))
      .toBe("STRIPE=[redacted-stripe-secret]");
    expect(redactSecretsInText(`STRIPE_TEST=${stripeTestSecret}`))
      .toContain("[redacted-stripe-secret]");
    expect(redactSecretsInText(`restricted ${stripeRestrictedKey} in env`))
      .toContain("[redacted-stripe-secret]");
    // Stripe publishable keys stay visible — they're embedded in
    // client-side code by design.
    expect(redactSecretsInText(`STRIPE_PUB=${stripePublishable}`))
      .toBe(`STRIPE_PUB=${stripePublishable}`);
    // GitLab PAT (modern glpat- prefix). Same split-prefix trick to
    // keep GitHub's scanner from flagging the source literal.
    const gitlabPat = `glpat${"-"}AbCdEfGhIjKlMnOpQrSt`;
    expect(redactSecretsInText(`ci token ${gitlabPat}`))
      .toContain("[redacted-gitlab-pat]");
    // Doesn't false-positive on a function call that happens to share the prefix.
    expect(redactSecretsInText("glpat-ok"))
      .toBe("glpat-ok");
  });

  it("redactSecretsInText covers the fine-grained GitHub PAT shape (goal 195)", () => {
    // Split the prefix so the source file has no contiguous
    // `github_pat_` literal for GitHub's push-protection scanner.
    const finePat = `github_pat${"_"}11ABCDEFG0aBcDeFgHiJ_kLmNoPqRsTuVwXyZ0123456789abcdefABCDEF`;
    expect(redactSecretsInText(`GH_TOKEN=${finePat} rest`))
      .toBe("GH_TOKEN=[redacted-github-pat] rest");
    // Classic PAT still works (no regression).
    expect(redactSecretsInText("gh token ghp_abcdefghijklmnopqrstuvwxyzABCDEF"))
      .toContain("[redacted-github-pat]");
    // No false positive on the bare prefix used in prose.
    expect(redactSecretsInText("set a github_pat_ in your env"))
      .toBe("set a github_pat_ in your env");
  });

  it("redactSecretsInText scrubs connection URIs with an inline password (goal 309)", () => {
    expect(redactSecretsInText("DB=postgres://muse:notarealpw@db.internal:5432/muse_db ok"))
      .toBe("DB=[redacted-connection-uri] ok");
    // Password-only (Redis-style) URI.
    expect(redactSecretsInText("cache redis://:authpw@host:6379/0 used"))
      .toContain("[redacted-connection-uri]");
    expect(redactSecretsInText("amqp://guest:guest@rabbit/vhost"))
      .toBe("[redacted-connection-uri]");
    // The whole credentialed URI is one unit even with a JWT-shaped
    // password (connection-uri runs before the jwt pattern).
    expect(
      redactSecretsInText("conn db://u:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.aaaaaaaaaa@host/x")
    ).toBe("conn [redacted-connection-uri]");
    // A credential-free https URL is NOT redacted (no regression).
    expect(redactSecretsInText("see https://docs.example.com/path"))
      .toBe("see https://docs.example.com/path");
    // Prose with an @ but no scheme:// is untouched.
    expect(redactSecretsInText("ping me at user@host about it"))
      .toBe("ping me at user@host about it");
  });

  it("truncateErrorBody trims + caps + appends ellipsis when over the cap", () => {
    expect(truncateErrorBody("")).toBe("");
    expect(truncateErrorBody(undefined)).toBe("");
    expect(truncateErrorBody("  hi  ")).toBe("hi");
    expect(truncateErrorBody("x".repeat(DEFAULT_ERROR_BODY_CAP))).toHaveLength(DEFAULT_ERROR_BODY_CAP);
    const big = truncateErrorBody("x".repeat(DEFAULT_ERROR_BODY_CAP + 50));
    expect(big.endsWith("…")).toBe(true);
    expect(big.length).toBe(DEFAULT_ERROR_BODY_CAP + 1); // cap + ellipsis
    expect(truncateErrorBody("short", 4)).toBe("shor…");
  });

  it("truncateErrorBody never leaves a lone surrogate at the cut boundary", () => {
    // "😀" is a surrogate pair (2 UTF-16 units). cap=3 cuts between
    // its halves — the orphaned high surrogate must be dropped, not
    // emitted as invalid UTF-8 into an error body / chat forward.
    expect(truncateErrorBody("ab😀cd", 3)).toBe("ab…");
    // No regression: a clean (non-astral) boundary is unchanged…
    expect(truncateErrorBody("abcdef", 3)).toBe("abc…");
    // …and an emoji fully inside the head is NOT over-trimmed.
    expect(truncateErrorBody("😀xxxxx", 4)).toBe("😀xx…");
  });
});

describe("formatErrorForTerminal — single sanitizer for printing unknown errors to a terminal so a malicious upstream's ESC bytes in error.message can't clear the user's screen or inject fake-prompt styling", () => {
  it("extracts message from an Error instance", () => {
    expect(formatErrorForTerminal(new Error("boom"))).toBe("boom");
  });

  it("falls back to String(cause) for non-Error throwables (a thrown string, number, plain object)", () => {
    expect(formatErrorForTerminal("plain string thrown")).toBe("plain string thrown");
    expect(formatErrorForTerminal(42)).toBe("42");
    expect(formatErrorForTerminal({ toString: () => "custom" })).toBe("custom");
  });

  it("strips ANSI escape / BEL / DEL / C1 control bytes from the message so a hostile upstream can't smuggle terminal commands into stderr", () => {
    const hostile = new Error(`\x1b[2J\x1b]0;pwned\x07Recoverable: connection reset\x9b31mfake-red\x7f`);
    const sanitised = formatErrorForTerminal(hostile);
    expect(sanitised).toBe("[2J]0;pwnedRecoverable: connection reset31mfake-red");
    expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(sanitised)).toBe(false);
  });

  it("preserves newlines and tabs (\\n / \\t) — only ESC / C0-other / DEL / C1 are stripped", () => {
    expect(formatErrorForTerminal(new Error("line1\nline2\tindented"))).toBe("line1\nline2\tindented");
  });

  it("applies the default body cap so a huge upstream-supplied error message can't flood stderr", () => {
    const long = "x".repeat(DEFAULT_ERROR_BODY_CAP + 50);
    const out = formatErrorForTerminal(new Error(long));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(DEFAULT_ERROR_BODY_CAP + 1);
  });

  it("honours an explicit cap arg for callers that want a tighter / looser bound", () => {
    expect(formatErrorForTerminal(new Error("abcdefghij"), 4)).toBe("abcd…");
  });

  it("returns the empty string for an Error whose message is empty (no spurious '…' / 'Error' string)", () => {
    expect(formatErrorForTerminal(new Error(""))).toBe("");
  });
});
