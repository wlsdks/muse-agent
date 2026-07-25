import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDisposableApiEnvironment,
  ensureDisposableApiDirectories
} from "./in-process-api.mjs";

export function createLiveLlmSmokeSandbox({
  port,
  provider,
  sourceEnv = process.env,
  tierModels
}) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new RangeError("port must be an integer between 1 and 65535");
  }
  if (
    !provider
    || typeof provider.model !== "string"
    || provider.model.trim().length === 0
    || typeof provider.providerId !== "string"
    || provider.providerId.trim().length === 0
  ) {
    throw new TypeError("provider must include non-empty model and providerId");
  }

  const rootDir = mkdtempSync(join(tmpdir(), "muse-live-llm-"));
  const cleanup = () => {
    rmSync(rootDir, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  };

  try {
    const env = createDisposableApiEnvironment({
      purpose: "live-llm",
      rootDir,
      sourceEnv
    });
    const storesDir = join(rootDir, "stores");
    Object.assign(env, {
      MUSE_CALENDAR_FILE: join(storesDir, "calendar.json"),
      MUSE_CALENDAR_PROVIDERS: "local",
      MUSE_CREDENTIALS_FILE: join(storesDir, "credentials.json"),
      MUSE_INPUT_GUARD_PII_ENABLED: "true",
      MUSE_MODEL: provider.model,
      MUSE_MODEL_PROVIDER_ID: provider.providerId,
      MUSE_USER_MEMORY_AUTO_EXTRACT:
        typeof sourceEnv.MUSE_USER_MEMORY_AUTO_EXTRACT === "string"
          ? sourceEnv.MUSE_USER_MEMORY_AUTO_EXTRACT
          : "true",
      OLLAMA_BASE_URL:
        typeof sourceEnv.OLLAMA_BASE_URL === "string"
          ? sourceEnv.OLLAMA_BASE_URL
          : "http://localhost:11434",
      PORT: String(port),
      ...(typeof sourceEnv.MUSE_USER_MEMORY_PERSIST === "string"
        ? { MUSE_USER_MEMORY_PERSIST: sourceEnv.MUSE_USER_MEMORY_PERSIST }
        : {}),
      ...(tierModels
        ? { MUSE_FAST_MODEL: tierModels.fast, MUSE_HEAVY_MODEL: tierModels.heavy }
        : {}),
      ...(provider.apiKey ? { MUSE_MODEL_API_KEY: provider.apiKey } : {})
    });
    ensureDisposableApiDirectories(env);

    const peopleDir = join(env.MUSE_NOTES_DIR, "people");
    mkdirSync(peopleDir, { recursive: true });
    writeFileSync(
      join(peopleDir, "mom.md"),
      "# Mom's birthday\n\nMay 15. Buy white roses and write a card mentioning the trip to Jeju.\n",
      "utf8"
    );
    writeFileSync(
      join(env.MUSE_NOTES_DIR, "house.md"),
      "Garage door opener spare battery is in the kitchen drawer next to the matches.\n",
      "utf8"
    );

    return { cleanup, env: Object.freeze(env), rootDir };
  } catch (error) {
    cleanup();
    throw error;
  }
}
