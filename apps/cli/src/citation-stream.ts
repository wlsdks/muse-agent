/**
 * Streaming citation gate for `muse ask`'s chat-only path.
 *
 * The grounded answer is STREAMED to the user token-by-token for liveness, but
 * the deterministic citation gate (`enforceAnswerCitations`) runs only AFTER the
 * full answer is buffered — so until now a fabricated `[from <source-you-don't-
 * have>]` would FLASH on screen during the stream even though the buffered copy
 * was cleaned (a code-acknowledged "known streaming limitation"). That defeats
 * the core promise — every claim cites a REAL source — for the streamed display.
 *
 * This filter closes it WITHOUT giving up streaming: it passes text straight
 * through, but the moment a `[` opens it HOLDS the span until its `]` (or a
 * newline / length cap proves it isn't a single-line citation), then runs the
 * complete `[…]` through the SAME `clean` function the buffered gate uses —
 * emitting a real citation unchanged and DROPPING a fabricated one before it ever
 * reaches the terminal. Non-citation brackets (`[1]`, `[a link]`) pass through
 * untouched. Pure + deterministic; the only state is the in-flight bracket span.
 */

const MAX_HELD = 200; // a real single-line citation is short; never hold more than this

export interface CitationStreamFilter {
  /** Feed a stream chunk; returns the text that is safe to emit NOW. */
  push(chunk: string): string;
  /** At stream end, emit any still-held (unclosed) span verbatim. */
  flush(): string;
}

/**
 * `clean` takes one complete `[…]` span and returns it unchanged if it is a real
 * citation (or not a citation at all), or "" if it is a fabricated citation to a
 * source the user doesn't have. In practice this is
 * `(span) => enforceAnswerCitations(span, allowed).text`.
 */
export function createCitationStreamFilter(clean: (span: string) => string): CitationStreamFilter {
  let held = "";
  let open = false;
  return {
    push(chunk: string): string {
      let out = "";
      for (const ch of chunk) {
        if (!open) {
          if (ch === "[") {
            open = true;
            held = "[";
          } else {
            out += ch;
          }
        } else {
          held += ch;
          if (ch === "]") {
            out += clean(held);
            held = "";
            open = false;
          } else if (ch === "\n" || held.length > MAX_HELD) {
            // not a single-line citation — release the held text as-is
            out += held;
            held = "";
            open = false;
          }
        }
      }
      return out;
    },
    flush(): string {
      const remaining = held;
      held = "";
      open = false;
      return remaining;
    }
  };
}
