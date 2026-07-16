/**
 * The desktop companion's deep link into a conversation: the native shell
 * opens the web console with `?companion_seed=<topic>` (CompanionSeed.swift)
 * expecting the chat composer pre-filled with that topic. Draft-first by
 * contract — the seed is NEVER auto-sent; the user confirms with Enter,
 * exactly like a starter chip.
 */

const PARAM = "companion_seed";

/** Composer drafts are user-editable text; cap the seed so a malformed or
 * hostile URL can't dump megabytes into React state. */
const MAX_SEED_LENGTH = 2000;

/** Window-safe wrapper: the console is also rendered without a DOM
 * (renderToStaticMarkup in tests), where there is no location to read. */
export function readLocationSeed(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return readCompanionSeed(window.location.search);
}

export function readCompanionSeed(search: string): string | undefined {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const raw = params.get(PARAM)?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.slice(0, MAX_SEED_LENGTH);
}

/** Remove the seed param from the address bar after consuming it, so a
 * manual refresh doesn't re-seed a composer the user already cleared. */
export function stripCompanionSeed(url: URL): URL {
  const next = new URL(url.toString());
  next.searchParams.delete(PARAM);
  return next;
}
