import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encryptFileAtRest, isFileEncryptedAtRest } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { atRestDoctorCheck, collectPrivacyPosture, formatPrivacyPosture, type PrivacyPosture } from "./commands-privacy.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "muse-privacy-"));
}

describe("collectPrivacyPosture — inventory each store's at-rest state + key posture", () => {
  it("reports a PLAINTEXT encryptable store, a MISSING store, and the derivable-key posture", async () => {
    const dir = tmpHome();
    const contacts = join(dir, "contacts.json");
    writeFileSync(contacts, JSON.stringify({ contacts: [{ id: "c", name: "Bob" }] }), "utf8");
    const env: Record<string, string | undefined> = {
      HOME: dir,
      MUSE_CONTACTS_FILE: contacts,
      MUSE_EPISODES_FILE: join(dir, "episodes.json"), // not created
      MUSE_USER_MEMORY_FILE: join(dir, "user-memory.json") // not created
      // MUSE_MEMORY_KEY unset → derivable fallback
    };
    const posture = await collectPrivacyPosture(env);
    const contactsStore = posture.stores.find((s) => s.name === "contacts")!;
    expect(contactsStore).toMatchObject({ encryptable: true, encrypted: false, exists: true });
    const episodes = posture.stores.find((s) => s.name === "episodes")!;
    expect(episodes).toMatchObject({ exists: false, encrypted: false });
    expect(posture.explicitKey).toBe(false); // no MUSE_MEMORY_KEY
  });

  it("detects an ENCRYPTED store and an explicit MUSE_MEMORY_KEY", async () => {
    const dir = tmpHome();
    const contacts = join(dir, "contacts.json");
    writeFileSync(contacts, JSON.stringify({ contacts: [] }), "utf8");
    await encryptFileAtRest(contacts, { MUSE_MEMORY_KEY: "s3cret-strong-key" });
    expect(await isFileEncryptedAtRest(contacts)).toBe(true); // sanity: the helper sees it encrypted
    const posture = await collectPrivacyPosture({ HOME: dir, MUSE_CONTACTS_FILE: contacts, MUSE_MEMORY_KEY: "s3cret-strong-key" });
    expect(posture.stores.find((s) => s.name === "contacts")!.encrypted).toBe(true);
    expect(posture.anyEncrypted).toBe(true);
    expect(posture.explicitKey).toBe(true);
  });

  it("marks tasks/reminders/notes as not-yet-encryptable (never falsely 'encrypted')", async () => {
    const posture = await collectPrivacyPosture({ HOME: tmpHome() });
    for (const name of ["tasks", "reminders", "notes"]) {
      const store = posture.stores.find((s) => s.name === name)!;
      expect(store.encryptable).toBe(false);
      expect(store.encrypted).toBe(false);
    }
  });
});

describe("formatPrivacyPosture", () => {
  const base = (over: Partial<PrivacyPosture>): PrivacyPosture => ({
    anyEncrypted: false,
    explicitKey: false,
    stores: [],
    ...over
  });

  it("flags a PLAINTEXT encryptable store with its encrypt command, and the WEAK fallback key", () => {
    const out = formatPrivacyPosture(base({
      anyEncrypted: true,
      explicitKey: false,
      stores: [
        { encryptCommand: "muse contacts encrypt", encryptable: true, encrypted: false, exists: true, name: "contacts", path: "/c" },
        { encryptable: true, encrypted: true, exists: true, name: "user-memory", path: "/m" }
      ]
    }));
    expect(out).toContain("⚠️  contacts");
    expect(out).toContain("run `muse contacts encrypt`");
    expect(out).toContain("✅ user-memory");
    expect(out).toContain("DERIVABLE per-host fallback");
    expect(out).toContain("Set MUSE_MEMORY_KEY");
  });

  it("reports a strong key when MUSE_MEMORY_KEY is explicit, and 'nothing encrypted' otherwise", () => {
    expect(formatPrivacyPosture(base({ anyEncrypted: true, explicitKey: true, stores: [{ encryptable: true, encrypted: true, exists: true, name: "contacts", path: "/c" }] })))
      .toContain("explicit MUSE_MEMORY_KEY");
    expect(formatPrivacyPosture(base({ anyEncrypted: false }))).toContain("Nothing is encrypted yet");
  });
});

describe("atRestDoctorCheck — surface the at-rest posture in `muse doctor`", () => {
  const posture = (over: Partial<PrivacyPosture>): PrivacyPosture => ({ anyEncrypted: false, explicitKey: false, stores: [], ...over });
  const store = (over: Partial<import("./commands-privacy.js").PrivacyStore> & { name: string }) =>
    ({ encryptable: true, encrypted: false, exists: true, path: `/${over.name}`, ...over });

  it("WARNs when an existing encryptable store is plaintext", () => {
    const c = atRestDoctorCheck(posture({ stores: [store({ encrypted: false, name: "contacts" }), store({ encrypted: true, name: "memory" })] }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("1/2 sensitive store(s) PLAINTEXT (contacts)");
    expect(c.detail).toContain("muse privacy");
  });

  it("WARNs when all are encrypted but under the derivable fallback key", () => {
    const c = atRestDoctorCheck(posture({ anyEncrypted: true, explicitKey: false, stores: [store({ encrypted: true, name: "memory" })] }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("DERIVABLE per-host key");
    expect(c.detail).toContain("MUSE_MEMORY_KEY");
  });

  it("is OK when all existing stores are encrypted with an explicit key", () => {
    const c = atRestDoctorCheck(posture({ anyEncrypted: true, explicitKey: true, stores: [store({ encrypted: true, name: "memory" })] }));
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("strong MUSE_MEMORY_KEY");
  });

  it("is OK (nothing to encrypt) when no sensitive store exists yet", () => {
    const c = atRestDoctorCheck(posture({ stores: [store({ exists: false, name: "memory" })] }));
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("nothing to encrypt");
  });
});
