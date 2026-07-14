import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmailStatusCard } from "./Integrations.js";
import { DICTIONARIES } from "../i18n/strings.js";
import { I18nProvider } from "../i18n/index.js";

import type { Translate } from "../i18n/index.js";
import type { EmailStatusResponse } from "../api/types.js";

const enT = ((key: keyof typeof DICTIONARIES.en) => DICTIONARIES.en[key]) as unknown as Translate;

function render(status: EmailStatusResponse | undefined): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <EmailStatusCard status={status} t={enT} />
    </I18nProvider>
  );
}

describe("EmailStatusCard — email status card, all four states", () => {
  it("configured via OAuth: shows the auto-refresh copy", () => {
    const html = render({ configured: true, hasRefreshToken: true, method: "oauth" });
    expect(html).toContain(DICTIONARIES.en["int.email.connectedOauth"]);
    expect(html).toContain(DICTIONARIES.en["int.email.title"]);
  });

  it("configured via App Password (IMAP): shows the IMAP copy", () => {
    const html = render({ configured: true, method: "imap" });
    expect(html).toContain(DICTIONARIES.en["int.email.connectedImap"]);
  });

  it("configured via MUSE_GMAIL_TOKEN env: shows the hourly-expiry + permanent-auth copy", () => {
    const html = render({ configured: true, method: "env" });
    expect(html).toContain(DICTIONARIES.en["int.email.connectedEnv"]);
    expect(html).toContain("muse setup email");
  });

  it("not configured: points at `muse setup email` and names both setup methods", () => {
    const html = render({ configured: false, method: null });
    expect(html).toContain("muse setup email");
    expect(html).toContain("App Password");
    expect(html).toContain("Google OAuth");
  });

  it("undefined status (query not yet resolved) renders the not-configured state, never throws", () => {
    expect(() => render(undefined)).not.toThrow();
    expect(render(undefined)).toContain("muse setup email");
  });

  it("never echoes a token, secret, or client id — the card copy is a static message + short badge only", () => {
    const html = render({ configured: true, hasRefreshToken: true, method: "oauth" });
    expect(html).not.toMatch(/ya29\.|client_secret|refresh_token/u);
  });

  it("every int.email.* key resolves to non-empty, distinct EN and KO copy", () => {
    for (const key of ["int.email.title", "int.email.connectedOauth", "int.email.connectedEnv", "int.email.notConfigured"] as const) {
      expect(DICTIONARIES.en[key]).toBeTruthy();
      expect(DICTIONARIES.ko[key]).toBeTruthy();
      expect(DICTIONARIES.en[key]).not.toBe(DICTIONARIES.ko[key]);
    }
  });
});
