const authorities = new WeakSet<object>();

export interface ProgressiveAutonomyOrganicAuthority {
  readonly __opaqueProgressiveAutonomyOrganicAuthority: never;
}

export function mintProgressiveAutonomyOrganicAuthority(): ProgressiveAutonomyOrganicAuthority {
  const authority = Object.freeze({});
  authorities.add(authority);
  return authority as ProgressiveAutonomyOrganicAuthority;
}

export function isProgressiveAutonomyOrganicAuthority(
  candidate: unknown
): candidate is ProgressiveAutonomyOrganicAuthority {
  return typeof candidate === "object" && candidate !== null && authorities.has(candidate);
}
