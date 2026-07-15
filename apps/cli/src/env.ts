/** Read a non-blank value from an injected command environment. */
export function readNonEmptyEnv(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}
