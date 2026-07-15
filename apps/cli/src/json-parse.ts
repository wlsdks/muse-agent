export type JsonPredicate<T> = (value: unknown) => value is T;

export function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseJsonWith<T>(raw: string, predicate: JsonPredicate<T>): T | undefined {
  const parsed = parseJson(raw);
  return parsed !== undefined && predicate(parsed) ? parsed : undefined;
}
