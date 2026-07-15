// Utilities for non-critical cleanup paths.
// Keeps production and test scripts readable when we intentionally ignore teardown failures.

/**
 * Run cleanup/teardown code that must never block the main control flow.
 * @param task A sync or async best-effort action.
 * @param context Human-readable label for optional debug tracing.
 */
export async function runBestEffort(task, context = "best-effort operation") {
  try {
    await task();
    return;
  } catch (error) {
    if (process.env.MUSE_BEST_EFFORT_TRACE === "1") {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`best-effort skip (${context}): ${message}`);
    }
  }
}

/**
 * Read a text file in a best-effort way and return a deterministic fallback
 * when the read fails (missing file, transient disk error, etc.).
 * @param read A sync or async read action returning a string.
 */
export async function readTextOrDefault(read, fallback = "") {
  try {
    return await read();
  } catch (error) {
    if (process.env.MUSE_BEST_EFFORT_TRACE === "1") {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`best-effort fallback (${read.name || "readTextOrDefault"}): ${message}`);
    }
    return fallback;
  }
}
