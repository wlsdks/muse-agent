/**
 * Encrypted credential store for the Muse CLI.
 *
 * The crypto + on-disk storage logic moved to `@muse/encrypted-credentials`
 * in `packages/stores` so `apps/api` (which cannot import from `apps/cli`)
 * can read the SAME `~/.config/muse/credentials.json` for read-only status
 * surfaces without duplicating it. This module re-exports the shared
 * implementation so every existing import site in the CLI (`program.ts`,
 * `gmail-oauth.ts`, `resolve-gmail-provider.ts`, `commands-auth.ts`, …)
 * keeps working unchanged — `ProgramIO` satisfies the shared
 * `CredentialStoreIO` seam structurally, so no adapter is needed at the
 * call sites.
 */

export {
  credentialPath,
  defaultCredentialPath,
  deleteEmailImapCredential,
  deleteGmailCredential,
  deleteStoredToken,
  hasStoredEmailImapCredentialSync,
  hasStoredGmailCredentialSync,
  readEmailImapCredential,
  readEmailImapCredentialSync,
  readGmailCredential,
  readStoredToken,
  writeEmailImapCredential,
  writeGmailCredential,
  writeStoredToken
} from "@muse/stores";
export type { CredentialStoreIO, GmailOAuthCredential, ImapEmailCredential } from "@muse/stores";

export { isRecord } from "@muse/shared";
