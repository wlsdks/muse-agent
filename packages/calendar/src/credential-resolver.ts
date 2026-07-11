/**
 * Live wiring of SecretSource into the calendar outbound credential-fetch path.
 *
 * Instead of reading a calendar credential field straight from the legacy
 * single-file store, we resolve it through the ordered SecretSource chain:
 *   env  →  macOS keychain (darwin only)  →  legacy store (FALLBACK)
 *
 * The legacy `FileCalendarCredentialStore` is the LAST source, so when no vault
 * is configured the chain falls through to it and behavior is UNCHANGED (zero
 * breakage). A user who moves a token into their keychain / `MUSE_SECRET_…` env
 * gets it read from there first — and it is registered for redaction on resolve.
 *
 * A calendar credential is a JSON object of fields; a `SecretRef` addresses ONE
 * field: `{ name: <field>, service: <providerId> }`.
 */

import {
  createEnvSource,
  createKeychainSource,
  createStoreSource,
  resolveSecret,
  type SecretRef,
  type SecretSource
} from "@muse/secrets";

import type { CalendarCredentialStore } from "./credential-store.js";

/** The keychain item service calendar secrets live under (`security -s`). */
export const CALENDAR_KEYCHAIN_SERVICE = "muse-calendar";

export interface CalendarSecretSourceOptions {
  /** Env view (tests). */
  readonly env?: NodeJS.ProcessEnv;
  /** Override the keychain source (tests inject a mock runner via createKeychainSource). */
  readonly keychain?: SecretSource;
  /** Include the OS keychain source in the chain. Default: only on darwin (`/usr/bin/security` exists nowhere else). */
  readonly useKeychain?: boolean;
  /** Test seam. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Build the ordered local-source chain for a calendar credential field, with
 * the legacy store as the final fallback. The store source is generic (a loader
 * callback) so this module never imports a concrete store class beyond the
 * interface — no reference cycle back into `@muse/secrets`.
 */
function createCalendarSecretSources(
  store: CalendarCredentialStore,
  options: CalendarSecretSourceOptions = {}
): SecretSource[] {
  const sources: SecretSource[] = [createEnvSource(options.env)];

  // An explicitly injected keychain source is always honored (the caller
  // already built it); otherwise default inclusion is darwin-only.
  const includeKeychain = options.useKeychain
    ?? (options.keychain !== undefined || (options.platform ?? process.platform) === "darwin");
  if (includeKeychain) {
    sources.push(
      options.keychain ?? createKeychainSource({ service: () => CALENDAR_KEYCHAIN_SERVICE })
    );
  }

  sources.push(
    createStoreSource("calendar-store", async (ref: SecretRef) => {
      const creds = await store.load(ref.service ?? "");
      const value = creds?.[ref.name];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    })
  );

  return sources;
}

/**
 * Resolve ONE calendar credential field through the chain. `providerId` is the
 * SecretRef service; `field` is the name. Returns the value or `undefined`.
 */
export async function resolveCalendarSecret(
  store: CalendarCredentialStore,
  providerId: string,
  field: string,
  options: CalendarSecretSourceOptions = {}
): Promise<string | undefined> {
  return resolveSecret({ name: field, service: providerId }, createCalendarSecretSources(store, options));
}
