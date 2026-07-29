import type {
  GraphAssertion,
  GraphDirection,
  GraphRef
} from "./types.js";
import { graphRefKey } from "./validation.js";

const RAW = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export type ThreadRootedWitnessPathStep = Readonly<{
  readonly assertion: GraphAssertion;
  readonly direction: "outgoing" | "incoming";
  readonly from: GraphRef;
  readonly to: GraphRef;
}>;

function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, value)
  ) as Readonly<T>;
}

function freezeArray<T>(value: readonly T[]): readonly T[] {
  return Object.freeze([...value]);
}

function directions(
  assertion: GraphAssertion,
  planDirection: GraphDirection
): readonly ThreadRootedWitnessPathStep[] {
  const output: ThreadRootedWitnessPathStep[] = [];
  if (planDirection !== "incoming") {
    output.push(freezeRecord({
      assertion,
      direction: "outgoing" as const,
      from: assertion.subject,
      to: assertion.object
    }));
  }
  if (planDirection !== "outgoing") {
    output.push(freezeRecord({
      assertion,
      direction: "incoming" as const,
      from: assertion.object,
      to: assertion.subject
    }));
  }
  return output;
}

export function findThreadRootedWitnessPath(
  seed: GraphRef,
  targetAssertionId: string,
  assertions: readonly GraphAssertion[],
  direction: GraphDirection,
  maxDepth: number
): readonly ThreadRootedWitnessPathStep[] | undefined {
  const adjacency = new Map<string, ThreadRootedWitnessPathStep[]>();
  for (const assertion of assertions) {
    for (const step of directions(assertion, direction)) {
      const key = graphRefKey(step.from);
      const list = adjacency.get(key);
      if (list) list.push(step);
      else adjacency.set(key, [step]);
    }
  }
  for (const steps of adjacency.values()) {
    steps.sort((left, right) =>
      RAW(left.assertion.id, right.assertion.id)
      || RAW(left.direction, right.direction)
    );
  }
  const queue: {
    readonly path: readonly ThreadRootedWitnessPathStep[];
    readonly ref: GraphRef;
  }[] = [{
    path: [],
    ref: seed
  }];
  const visitedDepth = new Map([[graphRefKey(seed), 0]]);
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    if (!entry || entry.path.length >= maxDepth) continue;
    for (const step of adjacency.get(graphRefKey(entry.ref)) ?? []) {
      if (entry.path.some((part) => part.assertion.id === step.assertion.id)) continue;
      const nextPath = [...entry.path, step];
      if (step.assertion.id === targetAssertionId) return freezeArray(nextPath);
      const nextKey = graphRefKey(step.to);
      const depth = nextPath.length;
      const previousDepth = visitedDepth.get(nextKey);
      if (previousDepth !== undefined && previousDepth <= depth) continue;
      visitedDepth.set(nextKey, depth);
      queue.push({ path: nextPath, ref: step.to });
    }
  }
  return undefined;
}
