import { createContext, useContext } from "react";

import type { ReactNode } from "react";

/** `undefined` while the health query hasn't resolved yet (unknown), `true`
 * once it settled ok, `false` once it settled NOT ok — the definitive
 * offline state views use to tell "server is down" apart from "some other
 * request failed". */
export type ConnectionState = boolean | undefined;

const ConnectionContext = createContext<ConnectionState>(undefined);

export function ConnectionProvider({
  connected,
  children
}: {
  connected: ConnectionState;
  children: ReactNode;
}) {
  return <ConnectionContext.Provider value={connected}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionState {
  return useContext(ConnectionContext);
}
