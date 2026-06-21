export function summarizeFlags(flags: readonly { enabled: boolean }[]): {
  total: number;
  enabled: number;
} {
  return {
    total: flags.length,
    enabled: flags.filter((f) => f.enabled).length
  };
}
