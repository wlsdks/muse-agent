/**
 * A sub-agent inherits the parent's tool deny: it may use ONLY tools the
 * parent could — never more. Returns the child's EFFECTIVE allowlist as the
 * intersection of what the child would get and the parent's allowlist.
 *
 * `undefined` means "no allowlist restriction" (everything allowed), so an
 * undefined PARENT imposes no ceiling and an undefined CHILD is clamped down
 * to whatever ceiling the parent does have — the structural analogue of
 * openclaw's subagent-capabilities (a sub-agent inherits the parent's deny,
 * it never widens it).
 */
export function inheritParentToolDeny(
  parentAllowedToolNames: readonly string[] | undefined,
  childAllowedToolNames: readonly string[] | undefined
): readonly string[] | undefined {
  if (parentAllowedToolNames === undefined) {
    return childAllowedToolNames === undefined ? undefined : [...childAllowedToolNames];
  }

  if (childAllowedToolNames === undefined) {
    return [...parentAllowedToolNames];
  }

  const childSet = new Set(childAllowedToolNames);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of parentAllowedToolNames) {
    if (childSet.has(name) && !seen.has(name)) {
      result.push(name);
      seen.add(name);
    }
  }

  return result;
}
