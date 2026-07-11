/**
 * One SSE frame ("event: x\ndata: a\ndata: b\n\n" minus the trailing blank
 * line) → its event name (defaults to "message", matching the browser
 * `EventSource` default) and the reassembled data. `sseData`
 * (apps/api/src/server-multipart-sse.ts) splits a multi-line value across
 * several `data:` lines within the SAME frame, so every line must be
 * collected and rejoined with `\n` — taking only the last line (as a naive
 * parser would) truncates any answer delta that spans a paragraph break.
 */
export function parseSseFrame(frame: string): { readonly eventName: string; readonly data: string } {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) {
      eventName = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    }
  }
  return { data: dataLines.join("\n"), eventName };
}

/** Splits a growing SSE byte buffer into complete (blank-line terminated)
 * frames plus the incomplete remainder to keep buffering. */
export function splitSseFrames(buffer: string): { readonly frames: readonly string[]; readonly rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((part) => part.trim().length > 0), rest };
}
