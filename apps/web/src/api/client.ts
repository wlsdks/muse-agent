/**
 * Typed fetch wrapper over the Muse API server. Every view talks to the
 * server only through this — the web ships no model logic of its own.
 */

export interface ApiClient {
  readonly baseUrl: string;
  readonly get: <T>(path: string) => Promise<T>;
  readonly post: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
  readonly put: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
  readonly patch: <T>(path: string, body?: Record<string, unknown>) => Promise<T>;
  readonly del: <T>(path: string) => Promise<T>;
}

export function createApiClient(baseUrl: string, token: string): ApiClient {
  return {
    baseUrl,
    del: (path) => request(baseUrl, token, path, undefined, "DELETE"),
    get: (path) => request(baseUrl, token, path, undefined, "GET"),
    patch: (path, body) => request(baseUrl, token, path, body, "PATCH"),
    post: (path, body) => request(baseUrl, token, path, body, "POST"),
    put: (path, body) => request(baseUrl, token, path, body, "PUT")
  };
}

async function request<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown> | undefined,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
): Promise<T> {
  const response = await fetch(new URL(path, baseUrl).toString(), {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    method
  });

  if (!response.ok) {
    throw new Error(await errorDetail(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  try {
    return JSON.parse(await response.text()) as T;
  } catch {
    // A proxy, captive portal, or truncated API body can still carry a 2xx
    // status. Do not leak a parser-specific SyntaxError into every query view.
    throw new Error(`Malformed API response (${response.status.toString()})`);
  }
}

// Prefer the server's actionable error body (`errorMessage` / `message` / `error`)
// over the bare status, which under HTTP/2 is often just a code.
async function errorDetail(response: Response): Promise<string> {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  try {
    const body = (await response.json()) as { error?: unknown; errorMessage?: unknown; message?: unknown };
    const candidate = [body.errorMessage, body.message, body.error].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    return candidate ? `${status}: ${candidate}` : status;
  } catch {
    return status;
  }
}
