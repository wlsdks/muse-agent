import { afterEach, describe, expect, it } from "vitest";
import { ImapSmtpAuthError } from "@muse/domain-tools";

import { setCliLanguage } from "./cli-i18n.js";
import { formatEmailAuthGuidance, noGmailAccessMessage } from "./email-auth-guidance.js";

describe("formatEmailAuthGuidance — AC3: code-driven, localized, never the raw English on ko", () => {
  afterEach(() => {
    setCliLanguage("en");
  });

  it("app-password-required (en): names the fix and appends the account-pinned URL, never the web-login-block guidance", () => {
    setCliLanguage("en");
    const cause = new ImapSmtpAuthError("IMAP login rejected — see docs", "app-password-required");
    const rendered = formatEmailAuthGuidance(cause, "user@gmail.com");
    expect(rendered).toContain("regular Google sign-in password");
    expect(rendered).toContain("https://myaccount.google.com/apppasswords?authuser=user%40gmail.com");
    expect(rendered).not.toContain("DisplayUnlockCaptcha");
  });

  it("app-password-required (ko): renders natural Korean, never the package's English message or the web-login-block guidance", () => {
    setCliLanguage("ko");
    const cause = new ImapSmtpAuthError("IMAP login rejected — see docs", "app-password-required");
    const rendered = formatEmailAuthGuidance(cause, "user@gmail.com");
    expect(rendered).toContain("일반 로그인 비밀번호");
    expect(rendered).not.toContain("IMAP login rejected");
    expect(rendered).toContain("https://myaccount.google.com/apppasswords?authuser=user%40gmail.com");
    expect(rendered).not.toContain("DisplayUnlockCaptcha");
  });

  it("omits the account-pinned URL when the email address isn't known to the caller", () => {
    setCliLanguage("en");
    const cause = new ImapSmtpAuthError("IMAP login rejected", "app-password-required");
    const rendered = formatEmailAuthGuidance(cause);
    expect(rendered).not.toContain("myaccount.google.com");
  });

  it("invalid-credentials (ko) never surfaces the account-pinned app-password URL (that's specific to app-password-required)", () => {
    setCliLanguage("ko");
    const cause = new ImapSmtpAuthError("IMAP login rejected", "invalid-credentials");
    const rendered = formatEmailAuthGuidance(cause, "user@gmail.com");
    expect(rendered).not.toContain("myaccount.google.com");
    expect(rendered).toContain("거부");
  });

  it("web-login-block (ko) points at the DisplayUnlockCaptcha remedy", () => {
    setCliLanguage("ko");
    const cause = new ImapSmtpAuthError("IMAP login rejected", "web-login-block");
    expect(formatEmailAuthGuidance(cause)).toContain("DisplayUnlockCaptcha");
  });

  it("appends the redacted server-said line when serverDetail is present", () => {
    setCliLanguage("en");
    const cause = new ImapSmtpAuthError("IMAP login rejected", "invalid-credentials", "Invalid credentials (Failure)");
    expect(formatEmailAuthGuidance(cause)).toContain('server said: "Invalid credentials (Failure)"');
  });

  it("auth-unknown falls back to the error's own (English) message — never a mistranslated guess", () => {
    setCliLanguage("ko");
    const cause = new ImapSmtpAuthError("some unclassified rejection text", "auth-unknown");
    expect(formatEmailAuthGuidance(cause)).toBe("some unclassified rejection text");
  });

  it("a plain (non-ImapSmtpAuthError) Error just passes its message through, unlocalized", () => {
    expect(formatEmailAuthGuidance(new Error("network is unreachable"))).toBe("network is unreachable");
  });

  it("a non-Error cause stringifies rather than throwing", () => {
    expect(formatEmailAuthGuidance("boom")).toBe("boom");
  });
});

describe("noGmailAccessMessage — shared 'Gmail not connected at all' hint (E4b audit #10/#14)", () => {
  afterEach(() => {
    setCliLanguage("en");
  });

  it("names the calling command and points at `muse setup email` / MUSE_GMAIL_TOKEN, without the raw scope jargon", () => {
    setCliLanguage("en");
    const rendered = noGmailAccessMessage("inbox");
    expect(rendered).toContain("muse inbox:");
    expect(rendered).toContain("muse setup email");
    expect(rendered).toContain("MUSE_GMAIL_TOKEN");
    expect(rendered).not.toContain("scope)");
  });

  it("renders in Korean and still names the calling command", () => {
    setCliLanguage("ko");
    const rendered = noGmailAccessMessage("email sync");
    expect(rendered).toContain("muse email sync:");
    expect(rendered).toContain("muse setup email");
  });
});
