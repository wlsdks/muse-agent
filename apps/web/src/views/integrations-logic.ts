import type { MessagingSetupProvider } from "../api/types.js";

export interface ProviderStatusView {
  readonly tone: "ok" | "warn" | "neutral";
  readonly labelKey: "int.status.connected" | "int.status.connectedEnv" | "int.status.savedNotLive" | "int.status.notConnected";
}

/** Status badge shape for one provider card — pure so it stays unit-testable. */
export function providerStatus(provider: MessagingSetupProvider): ProviderStatusView {
  if (!provider.configured) {
    return { labelKey: "int.status.notConnected", tone: "neutral" };
  }
  if (!provider.registered) {
    // Credential persisted but the running server has no live provider —
    // the state after a manual file edit or a failed boot; surfacing it
    // beats a silent "connected" that can't actually send.
    return { labelKey: "int.status.savedNotLive", tone: "warn" };
  }
  return provider.source === "env"
    ? { labelKey: "int.status.connectedEnv", tone: "ok" }
    : { labelKey: "int.status.connected", tone: "ok" };
}

/** Env-sourced credentials outlive the UI (only the shell can unset them). */
export function canDisconnect(provider: MessagingSetupProvider): boolean {
  return provider.configured && provider.source === "file";
}
