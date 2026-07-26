export interface ActiveAttunementPolicyWriteGate {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export class ActiveAttunementPolicyWriteBlockedError extends Error {
  readonly code = "MUSE_ACTIVE_ATTUNEMENT_POLICY_WRITE_BLOCKED";
  readonly reason = "qualification-hold-unavailable";

  constructor() {
    super("active Attunement policy mutation blocked: qualification-hold-unavailable");
    this.name = "ActiveAttunementPolicyWriteBlockedError";
  }
}

export function runActiveAttunementPolicyMutation<T>(
  gate: ActiveAttunementPolicyWriteGate | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (!gate) throw new ActiveAttunementPolicyWriteBlockedError();
  return gate.run(operation);
}
