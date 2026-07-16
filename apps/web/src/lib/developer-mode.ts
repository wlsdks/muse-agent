/**
 * Developer mode gates the engine-room views (tools, scheduler, prompt lab,
 * metrics…) out of the sidebar for the default companion posture — OFF means
 * they are removed, not merely collapsed. Everything stays reachable through
 * the ⌘K palette and keyboard leader shortcuts regardless, so muscle memory
 * and power access survive; the flag only decides what the sidebar teaches
 * the eye is "normal".
 */

const KEY = "muse.developerMode";
const EVENT = "muse:developer-mode";

export function readDeveloperMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDeveloperMode(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: enabled }));
}

/** Subscribe to live developer-mode flips (the Settings toggle fires the
 * event); returns the unsubscribe. Window-safe for static renders. */
export function onDeveloperModeChange(listener: (enabled: boolean) => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handler = (event: Event) => listener(Boolean((event as CustomEvent).detail));
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
