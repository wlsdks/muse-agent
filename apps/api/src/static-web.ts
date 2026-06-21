import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

import type { FastifyInstance } from "fastify";

/// Serve the built Muse web UI (a Vite SPA) from the same origin as the API, so
/// the desktop app can host the entire web experience in one self-contained
/// server (no separate dev server, no CORS). Enabled only when MUSE_WEB_DIR
/// points at a real directory — a plain `pnpm dev` API without it is unchanged.
///
/// Zero-dependency: a single not-found handler streams files from the web dir
/// and falls back to index.html for client-side routes. `/api/*` misses still
/// return a JSON 404 (never the SPA shell).

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function registerStaticWeb(server: FastifyInstance, webDir = process.env.MUSE_WEB_DIR): void {
  if (!webDir) return;
  const root = normalize(webDir);

  server.setNotFoundHandler(async (request, reply) => {
    // Unmatched API routes are real 404s, never the SPA shell.
    if (request.url.startsWith("/api/") || request.url === "/api") {
      return reply.status(404).send({ error: "Not found", path: request.url, timestamp: new Date().toISOString() });
    }

    const urlPath = decodeURIComponent((request.url.split("?")[0] ?? "/"));
    const requested = normalize(join(root, urlPath));
    // Path-traversal guard: never serve outside the web root.
    const candidate = requested.startsWith(root) ? requested : root;

    const file = await readableFile(candidate);
    if (file) {
      return reply.type(contentType(file)).send(await readFile(file));
    }
    // SPA fallback — hand client-side routes the app shell.
    const index = join(root, "index.html");
    if (await readableFile(index)) {
      return reply.type("text/html; charset=utf-8").send(await readFile(index));
    }
    return reply.status(404).send({ error: "Web UI not built", timestamp: new Date().toISOString() });
  });
}

/// Returns the path if it is an existing regular file, else null.
async function readableFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? path : null;
  } catch {
    return null;
  }
}
