/**
 * Create a branded runtime O(1) membership predicate for a literal string
 * collection. The returned guard is safe for control-flow narrowing and
 * avoids repeating `new Set(...).has(...)` in every call site.
 */
export function createStringSetGuard<const T extends readonly string[]>(values: T): (value: string) => value is T[number] {
  const allowed = new Set<T[number]>(values);
  return (value: string): value is T[number] => allowed.has(value);
}

