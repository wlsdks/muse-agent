/**
 * Tiny fetch wrapper used by every web panel. Lifted out of `App.tsx`
 * so panel files can import the typed surface without depending on
 * the App barrel.
 */

export interface ApiClient {
  readonly get: <T>(path: string) => Promise<T>;
  readonly post: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
  readonly put: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
  readonly delete: <T>(path: string) => Promise<T>;
}

export function createApiClient(baseUrl: string, token: string): ApiClient {
  return {
    delete: (path) => request(baseUrl, token, path, undefined, "DELETE"),
    get: (path) => request(baseUrl, token, path),
    post: (path, body) => request(baseUrl, token, path, body, "POST"),
    put: (path, body) => request(baseUrl, token, path, body, "PUT")
  };
}

async function request<T>(
  baseUrl: string,
  token: string,
  path: string,
  body?: Record<string, unknown>,
  methodOverride?: "GET" | "POST" | "PUT" | "DELETE"
): Promise<T> {
  const method = methodOverride ?? (body ? "POST" : "GET");
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

  return response.json() as Promise<T>;
}

// Surface the server's actionable error body (the `errorMessage` /
// `message` the API returns — e.g. "upstream unavailable, retry")
// instead of a bare status, which under HTTP/2 is often just the
// code with an empty statusText.
async function errorDetail(response: Response): Promise<string> {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  try {
    const body = (await response.json()) as { errorMessage?: unknown; message?: unknown };
    const candidate = [body.errorMessage, body.message].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    return candidate ? `${status}: ${candidate}` : status;
  } catch {
    return status;
  }
}
