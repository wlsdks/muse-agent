export async function withBestEffort<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}
