export function errorMessage(value: unknown): string {
  return value instanceof Error && value.message.trim().length > 0 ? value.message : "request failed";
}
