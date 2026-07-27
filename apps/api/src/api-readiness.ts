export type ApiDependencyName = "model" | "network" | "resident" | "stores";
export type ApiDependencyStatus = "not-required" | "ready" | "unavailable" | "unverified";

export interface ApiDependencyReadinessSnapshot {
  readonly model?: ApiDependencyStatus;
  readonly network?: ApiDependencyStatus;
  readonly resident?: ApiDependencyStatus;
  readonly stores?: ApiDependencyStatus;
}

export type ApiReadinessReason =
  | "agent-runtime-unverified"
  | "agent-runtime-unavailable"
  | "model-unconfigured"
  | "model-unavailable"
  | "model-unverified"
  | "network-unavailable"
  | "network-unverified"
  | "readiness-snapshot-unavailable"
  | "stores-unavailable"
  | "stores-unverified";

export interface ApiHealthProjection {
  readonly degraded: boolean;
  readonly dependencies: Readonly<Record<ApiDependencyName, ApiDependencyStatus>>;
  readonly liveness: {
    readonly status: "up";
  };
  readonly readiness: {
    readonly reasons: readonly ApiReadinessReason[];
    readonly status: "not-ready" | "ready";
  };
}

export interface ApiHealthProjectionInput {
  readonly dependencyReadiness?: ApiDependencyReadinessSnapshot;
  readonly localOnly: boolean;
  readonly modelConfigured: boolean;
  readonly residentConfigured: boolean;
}

export function projectApiHealth(input: ApiHealthProjectionInput): ApiHealthProjection {
  const defaults: Record<ApiDependencyName, ApiDependencyStatus> = {
    model: input.modelConfigured ? "ready" : "unavailable",
    network: !input.modelConfigured || input.localOnly ? "not-required" : "unverified",
    resident: input.residentConfigured ? "ready" : "unavailable",
    stores: "ready"
  };
  let snapshot: ApiDependencyReadinessSnapshot = {};
  let snapshotUnavailable = false;
  try {
    snapshot = input.dependencyReadiness === undefined
      ? {}
      : {
          model: normalizeStatus(input.dependencyReadiness.model, false),
          network: normalizeStatus(input.dependencyReadiness.network, true),
          resident: normalizeStatus(input.dependencyReadiness.resident, false),
          stores: normalizeStatus(input.dependencyReadiness.stores, false)
        };
  } catch {
    snapshotUnavailable = true;
  }

  const dependencies = {
    model: combineConfiguredDependency(defaults.model, snapshot.model),
    network: combineNetworkDependency(defaults.network, snapshot.network),
    resident: combineConfiguredDependency(defaults.resident, snapshot.resident),
    stores: snapshot.stores ?? defaults.stores
  } satisfies Record<ApiDependencyName, ApiDependencyStatus>;
  const reasons = readinessReasons(dependencies, input.modelConfigured, snapshotUnavailable);
  const ready = reasons.length === 0;
  return {
    degraded: !ready,
    dependencies,
    liveness: { status: "up" },
    readiness: {
      reasons,
      status: ready ? "ready" : "not-ready"
    }
  };
}

function combineConfiguredDependency(
  configured: ApiDependencyStatus,
  observed: ApiDependencyStatus | undefined
): ApiDependencyStatus {
  if (configured !== "ready") return configured;
  return observed === "not-required" ? "unverified" : (observed ?? configured);
}

function combineNetworkDependency(
  baseline: ApiDependencyStatus,
  observed: ApiDependencyStatus | undefined
): ApiDependencyStatus {
  if (baseline === "not-required") return baseline;
  if (observed === "not-required") return "unverified";
  return observed ?? baseline;
}

function normalizeStatus(
  status: ApiDependencyStatus | undefined,
  allowNotRequired: boolean
): ApiDependencyStatus | undefined {
  if (status === undefined) return undefined;
  if (status === "ready" || status === "unavailable" || status === "unverified") return status;
  return allowNotRequired && status === "not-required" ? status : "unverified";
}

function readinessReasons(
  dependencies: Readonly<Record<ApiDependencyName, ApiDependencyStatus>>,
  modelConfigured: boolean,
  snapshotUnavailable: boolean
): ApiReadinessReason[] {
  const reasons: ApiReadinessReason[] = [];
  if (dependencies.model === "unavailable") {
    reasons.push(modelConfigured ? "model-unavailable" : "model-unconfigured");
  }
  if (dependencies.model === "unverified") reasons.push("model-unverified");
  if (dependencies.resident === "unavailable") reasons.push("agent-runtime-unavailable");
  if (dependencies.resident === "unverified") reasons.push("agent-runtime-unverified");
  if (dependencies.network === "unavailable") reasons.push("network-unavailable");
  if (dependencies.network === "unverified") reasons.push("network-unverified");
  if (dependencies.stores === "unavailable") reasons.push("stores-unavailable");
  if (dependencies.stores === "unverified") reasons.push("stores-unverified");
  if (snapshotUnavailable) reasons.push("readiness-snapshot-unavailable");
  return reasons;
}
