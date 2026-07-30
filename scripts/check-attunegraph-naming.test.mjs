import assert from "node:assert/strict";
import test from "node:test";
import { scanAttuneGraphNaming } from "./check-attunegraph-naming.mjs";

const word = (...parts) => parts.join("");
const short = word("m", "ag");
const long = word("Attunement", "Graph");
const fixture = (path, content) => scanAttuneGraphNaming({
  cwd: "/no-such-root",
  paths: [path],
  read: () => Buffer.from(content, "utf8")
});

for (const [label, path, content] of [
  ["old package path", word("packages/attunement-", "graph/src/index.ts"), "export {}"],
  ["long product content", "note.md", long],
  ["standalone lowercase compatibility identity", "note.md", short],
  ["standalone compatibility type", "note.md", `${short[0].toUpperCase()}${short.slice(1)}`],
  ["wildcard compatibility family", "note.md", `${short[0].toUpperCase()}${short.slice(1)}*`],
  ["camel acronym", "note.md", `${short}Store`],
  ["pascal acronym", "note.md", `${short[0].toUpperCase()}${short.slice(1)}Store`],
  ["terminal camel function", "note.md", `open${short[0].toUpperCase()}${short.slice(1)}`],
  ["environment acronym", "note.md", `${short.toUpperCase()}_INPUT_TYPE_CHILD`],
  ["portable format", "manifest.json", word("muse-", short, "-portable")],
  ["portable extension", "fixture.atgx", word("legacy", ".", short, "x")],
  ["dotted identity", "note.md", word("muse.", short, ".canonical-projection.v1")],
  ["worker identity", "note.md", word(short, "-admin-validation-v1-")],
  ["core-only local subpath on Muse integration", "note.md", word("@muse/", "attunegraph", "/local")],
  ["core-only backend subpath on Muse integration", "note.md", word("@muse/", "attunegraph", "/backend")],
  ["core-only admin subpath on Muse integration", "note.md", word("@muse/", "attunegraph", "/admin")]
]) {
  test(`rejects ${label}`, () => assert.ok(fixture(path, content).length > 0));
}

test("allows unrelated Muse identities and numeric legacy rejection evidence", () => {
  const findings = fixture("legacy.test.ts", "const numeric = 0x4d414731; const bytes = [0x6d, 0x61, 0x67]; const domain = 'muse.attunement.continuity.v1'; const temp = 'muse-continuity-run';");
  assert.deepEqual(findings, []);
});

test("allows ordinary words and unrelated magic constants", () => {
  const findings = fixture(
    "ordinary.ts",
    "const MUSE_EXPORT_MAGIC = true; const label = 'MAGNITUDE'; const pkg = 'magic-string'; const imageMagic = true;"
  );
  assert.deepEqual(findings, []);
});
