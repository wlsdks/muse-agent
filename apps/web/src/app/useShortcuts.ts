import { useEffect } from "react";

// The Vim-style leader prefix. A view's jump key can never be this letter
// (a second press just re-arms the leader), so NAV keys are guarded against it.
export const LEADER_KEY = "g";

/**
 * Global keyboard shortcuts. `⌘K` / `Ctrl+K` toggles the command
 * palette; a Vim-style `g` leader followed by a letter jumps to a view
 * (`onLeader("t")` etc). Ignores keystrokes typed into inputs so it
 * never hijacks the chat composer or a search box.
 */
export function useShortcuts(opts: {
  onTogglePalette: () => void;
  onLeader: (key: string) => void;
  /** ⌘B / Ctrl+B — the industry-standard sidebar toggle (shadcn/VS Code). */
  onToggleSidebar?: () => void;
}): void {
  const { onLeader, onTogglePalette, onToggleSidebar } = opts;

  useEffect(() => {
    let leaderUntil = 0;

    const isTyping = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) {
        return false;
      }
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onTogglePalette();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && onToggleSidebar) {
        e.preventDefault();
        onToggleSidebar();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) {
        return;
      }
      const now = Date.now();
      if (e.key === LEADER_KEY) {
        leaderUntil = now + 1000;
        return;
      }
      if (now < leaderUntil && /^[a-z]$/.test(e.key)) {
        leaderUntil = 0;
        onLeader(e.key);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onLeader, onTogglePalette, onToggleSidebar]);
}
