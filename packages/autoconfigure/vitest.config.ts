import { mergeConfig } from "vitest/config";

import shared from "../../vitest.shared";

// Extend the repo-shared config with a per-file HOME isolation setup so no test
// in this package can write into the developer's real ~/.muse (see
// test/isolate-home.setup.ts and the provider-paths fail-close guard).
export default mergeConfig(shared, {
  test: {
    setupFiles: ["./test/isolate-home.setup.ts"]
  }
});
