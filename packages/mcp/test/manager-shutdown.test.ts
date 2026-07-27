import { describe, expect, it, vi } from "vitest";

import {
  InMemoryMcpServerStore,
  McpManager,
  type McpConnection
} from "../src/index.js";

function connection(close: () => Promise<void>): McpConnection {
  return {
    close,
    listTools: async () => []
  };
}

async function register(manager: McpManager, name: string): Promise<void> {
  await manager.register({
    config: { command: "node" },
    name,
    transportType: "stdio"
  });
}

describe("McpManager shutdown", () => {
  it("is idempotent, closes every live connection once, and does not let one close failure skip another", async () => {
    const firstClose = vi.fn(async () => {
      throw new Error("first close failed");
    });
    const secondClose = vi.fn(async () => undefined);
    const connections = [connection(firstClose), connection(secondClose)];
    const connector = {
      connect: vi.fn(async () => connections.shift()!)
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), { connector });
    await register(manager, "first");
    await register(manager, "second");
    await expect(manager.connect("first")).resolves.toBe(true);
    await expect(manager.connect("second")).resolves.toBe(true);

    const shutdown = manager.shutdown();
    await expect(shutdown).rejects.toThrow("MCP manager shutdown failed");
    await expect(manager.shutdown()).rejects.toThrow("MCP manager shutdown failed");

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(manager.getToolCatalog()).toEqual([]);
    expect(manager.getStatus("first")).toBe("disconnected");
    expect(manager.getStatus("second")).toBe("disconnected");
    await expect(manager.connect("first")).resolves.toBe(false);
    await expect(manager.reconnectDue()).resolves.toEqual([]);
    expect(connector.connect).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-flight connect, closes the late connection once, and never exposes its tools", async () => {
    const connectorCalled = Promise.withResolvers<void>();
    const lateConnection = Promise.withResolvers<McpConnection>();
    const close = vi.fn(async () => undefined);
    const connector = {
      connect: vi.fn(() => {
        connectorCalled.resolve();
        return lateConnection.promise;
      })
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), { connector });
    await register(manager, "late");

    const connecting = manager.connect("late");
    await connectorCalled.promise;
    const shutdown = manager.shutdown();
    lateConnection.resolve(connection(close));

    await expect(connecting).resolves.toBe(false);
    await expect(shutdown).resolves.toBeUndefined();
    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus("late")).toBe("disconnected");
    expect(manager.getToolCatalog("late")).toEqual([]);
    expect(manager.toMuseTools()).toEqual([]);
  });

  it("closes a connection whose catalog resolves during shutdown without publishing late tools", async () => {
    const catalogStarted = Promise.withResolvers<void>();
    const catalog = Promise.withResolvers<readonly [{ name: string; risk: "read" }]>();
    const close = vi.fn(async () => undefined);
    const late: McpConnection = {
      close,
      listTools: () => {
        catalogStarted.resolve();
        return catalog.promise;
      }
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: { connect: async () => late }
    });
    await register(manager, "catalog-race");

    const connecting = manager.connect("catalog-race");
    await catalogStarted.promise;
    const shutdown = manager.shutdown();
    catalog.resolve([{ name: "late_tool", risk: "read" }]);

    await expect(connecting).resolves.toBe(false);
    await expect(shutdown).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.getToolCatalog()).toEqual([]);
    expect(manager.toMuseTools()).toEqual([]);
  });

  it("waits for an in-flight health catalog and prevents it from reviving a disconnected manager", async () => {
    const healthCatalogStarted = Promise.withResolvers<void>();
    const healthCatalog = Promise.withResolvers<readonly [{ name: string; risk: "read" }]>();
    const close = vi.fn(async () => undefined);
    let catalogCalls = 0;
    const live: McpConnection = {
      close,
      listTools: () => {
        catalogCalls += 1;
        if (catalogCalls === 1) return [];
        healthCatalogStarted.resolve();
        return healthCatalog.promise;
      }
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: { connect: async () => live }
    });
    await register(manager, "health-race");
    await manager.connect("health-race");

    const health = manager.healthCheck("health-race");
    await healthCatalogStarted.promise;
    const shutdown = manager.shutdown();
    const shutdownReturnedEarly = await Promise.race([
      shutdown.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20))
    ]);
    healthCatalog.resolve([{ name: "late_health_tool", risk: "read" }]);
    await Promise.all([health, shutdown]);

    expect(shutdownReturnedEarly).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.getStatus("health-race")).toBe("disconnected");
    expect(manager.getToolCatalog()).toEqual([]);
    expect(manager.toMuseTools()).toEqual([]);
  });
});
