import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTUNEGRAPH_SUBMODULE_GATE_PACKAGES,
  hasAttuneGraphGitlinkChange,
  isVitestBrowserConfig
} from "./test-changed.mjs";

test("AttuneGraph gitlink changes select the conservative compatibility gates", () => {
  assert.equal(
    hasAttuneGraphGitlinkChange(":160000 160000 before after M\tpackages/attunegraph"),
    true
  );
  assert.deepEqual(ATTUNEGRAPH_SUBMODULE_GATE_PACKAGES, [
    "@attunegraph/core",
    "@muse/attunegraph",
    "@muse/cli"
  ]);
});

test("ordinary tree changes do not select the gitlink gates", () => {
  assert.equal(
    hasAttuneGraphGitlinkChange(":100644 100644 before after M\tpackages/attunegraph/src/index.ts"),
    false
  );
});

test("only the package browser config selects the full Browser Mode suite", () => {
  assert.equal(isVitestBrowserConfig("vitest.browser.config.ts"), true);
  assert.equal(isVitestBrowserConfig("src/view.browser.test.tsx"), false);
  assert.equal(isVitestBrowserConfig("vitest.config.ts"), false);
});
