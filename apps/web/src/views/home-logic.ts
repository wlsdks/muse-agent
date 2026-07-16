/**
 * Deterministic derivations for the 홈 view — what Muse can be asked to do
 * RIGHT NOW given what is connected, and the seed-chat bridge. Pure module
 * so the capability gating is unit-testable without a render.
 */

import type { StringKey } from "../i18n/strings.js";

export interface HomeCapabilityInput {
  readonly emailConfigured: boolean;
  readonly threadCount: number;
}

export interface HomeCapability {
  readonly id: string;
  readonly labelKey: StringKey;
  /** Chat prompt this capability seeds — absent when it navigates instead. */
  readonly promptKey?: StringKey;
  /** View to open when there is no prompt (e.g. thread resume). */
  readonly navigate?: string;
}

/** The honest ask-me list: an entry appears ONLY when its backing capability
 * is actually available (email hidden until configured, thread resume hidden
 * until a thread exists). Local stores (notes/calendar/reminders) are always
 * on — they need no integration. */
export function homeCapabilities(input: HomeCapabilityInput): readonly HomeCapability[] {
  const caps: HomeCapability[] = [
    { id: "notes", labelKey: "home.cap.notes", promptKey: "home.cap.notes.prompt" },
    { id: "calendar", labelKey: "home.cap.calendar", promptKey: "home.cap.calendar.prompt" },
    { id: "reminder", labelKey: "home.cap.reminder", promptKey: "home.cap.reminder.prompt" }
  ];
  if (input.emailConfigured) {
    caps.push({ id: "email", labelKey: "home.cap.email", promptKey: "home.cap.email.prompt" });
  }
  if (input.threadCount > 0) {
    caps.push({ id: "threads", labelKey: "home.cap.threads", navigate: "continuity" });
  }
  return caps;
}

/** Bridge into a seeded conversation: plant the same `companion_seed` param
 * the native shell uses, then navigate — ChatSession consumes it at mount
 * (draft-first, never auto-sent) and strips the URL. Reusing the shell's
 * one mechanism keeps a single seeding contract. */
export function seedChat(prompt: string, navigate: (view: string) => void): void {
  if (typeof window !== "undefined") {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("companion_seed", prompt);
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* URL/history unavailable — navigation still works, just unseeded */
    }
  }
  navigate("chat");
}
