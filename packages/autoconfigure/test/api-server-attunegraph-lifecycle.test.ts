import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServerOptions } from "../src/api-server-options.js";

const temporaryDirectories: string[] = [];

async function temporaryHome(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "muse-api-attunegraph-lifecycle-"))
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("API AttuneGraph resource ownership", () => {
  it("owns a lazy shared session only when the configured database is enabled", async () => {
    const home = await temporaryHome();
    const common = {
      HOME: home,
      MUSE_ACTIVE_CONTEXT_ENABLED: "false",
      MUSE_SCHEDULER_PERSIST: "false",
      MUSE_TASK_MEMORY_PERSIST: "false"
    };
    const disabled = createApiServerOptions({ env: common });
    const enabled = createApiServerOptions({
      env: {
        ...common,
        MUSE_ATTUNEGRAPH_DATABASE: join(home, "attunegraph.sqlite")
      }
    });

    expect(disabled).not.toHaveProperty("closeRuntimeResources");
    expect(enabled.closeRuntimeResources).toEqual(expect.any(Function));
    const closing = enabled.closeRuntimeResources!();
    expect(enabled.closeRuntimeResources!()).toBe(closing);
    await expect(closing).resolves.toBeUndefined();
  });
});
