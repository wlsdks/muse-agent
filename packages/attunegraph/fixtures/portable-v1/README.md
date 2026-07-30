# AttuneGraph portable v1 fixture corpus

This directory is a standalone compatibility oracle for the byte-level
`attunegraph-portable` v1 contract. Each `*.input.json` file contains immutable,
trusted stored-projection values that were previously admitted by the AttuneGraph Engine.
The clean-room verifier does not import or call that Engine and does not claim to
test admission. It independently recalculates only the `attunegraph-store:` envelope
identity over each trusted stored projection, then derives every portable record,
head, count, hash, line ledger, and final artifact byte.

The three cases cover an empty journal, one scope with two contiguous generations,
and scrambled multi-scope Unicode data. The Unicode case preserves `U+E000` and
`U+10000` in both source and tied-source thread positions, plus distinct decomposed
`e\u0301` and precomposed `é` scopes. Portable order is unsigned raw UTF-8 byte
order, never JavaScript UTF-16 key order, locale order, or normalized text order.

From the repository root:

```sh
pnpm --filter @attunegraph/core verify:portable-fixtures
```

That command is read-only. `--check-dir <existing-dir>` checks a copied or
third-party corpus. `--output-dir <existing-empty-dir>` writes an independently
derived corpus into that directory only; the checked-in directory is explicitly
rejected as an output. There is no update or write-to-repository mode.

Every `.atgx` file must be canonical UTF-8 NDJSON with LF-only line endings and a
final LF. The verifier rejects BOM, CR, blank lines, missing final LF, and records
after the footer before it parses record JSON. `manifest.json` records exact
artifact bytes and SHA-256, state/export identities, counts, and the byte lengths
and identity of every line.
