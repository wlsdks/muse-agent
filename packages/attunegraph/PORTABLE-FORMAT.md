# AttuneGraph portable format (`.atgx`) v1

Status: **encoder core, golden integration, streaming/order qualification,
shared-path reduced-budget qualification, package-private decoder implementation, and
structural decoder non-retention qualification, and SQLite indexed validation substrate
and POSIX Admin staging lifecycle verified-current**. This document fixes the portable
wire contract. The package-private transactional encoder has a mandatory exact-head
identity sink, deterministic production and clean-room fixture generation, recoverable
refresh rollback, raw UTF-8 ordering tests, and deterministic streaming non-retention
qualification. The decoder has exhaustive chunk-boundary families and closed
retained-state ledgers. These are structural JavaScript-heap results, not RSS,
production-scale, empirical asymptotic, or cross-runtime proof.

The package-private indexed validation substrate owns a caller-opened empty
`DatabaseSync`, stores only the current final identity and `head_seen` per exact
raw-UTF-8-BLOB scope, and closes transactional staging after exact
head/count/profile checks. Its POSIX filesystem owner requires a canonical
owner-private directory, reserves an exclusive no-follow target, pins directory
and file device/inode identities, and records only verified SQLite files in
immutable capability-bound receipts. Unknown native-close outcomes preserve
toxic unpublished residue. No public decoder, filesystem publisher,
destination-generation publisher, Admin command, or administration API ships.

## 1. Purpose and boundary

A `.atgx` artifact transfers the logical AttuneGraph projection journal and its exact final
per-scope heads between compatible implementations. It is independent of the current
physical SQLite schema. It is also independent of any future assertion-event journal:
portable v1 contains stored projections and final heads, not SQLite pages, WAL state, or
assertion events.

The format is a portable export/rebuild contract, not a backup contract. Its SHA-256
identifiers detect accidental or hostile byte substitution but do not provide
authenticity, authorization, signatures, encryption, confidentiality, or proof of who
created an artifact. A backup system may carry `.atgx`, but must define retention,
authentication, encryption, and recovery policy separately.

## 2. Byte and canonical JSON contract

The artifact is canonical NDJSON:

1. exactly one manifest line;
2. zero or more projection lines;
3. zero or more head lines;
4. exactly one footer line.

Every line is the UTF-8 encoding of the canonical JSON object followed by one LF byte
(`0x0a`). The footer LF is the final byte. A decoder MUST use fatal UTF-8 decoding and
MUST reject a BOM, invalid UTF-8, CRLF, blank lines, non-canonical JSON, a missing final
LF, or any bytes after the footer LF.

Canonical JSON is `attunegraph-canonical-json-utf16@1`. Object keys are sorted by raw UTF-16
code-unit order, recursively; the key order shown in the schemas below is that canonical
order. Arrays retain their declared order. Strings are preserved byte-for-byte after
UTF-8 decoding: implementations MUST NOT apply Unicode normalization. Unpaired UTF-16
surrogates are invalid. Numbers used by this format are non-negative JavaScript safe
integers; non-integers, negative values, unsafe integers, `-0`, non-finite values, and
alternate numeric spellings are invalid.

Projection records are sorted by the raw UTF-8 bytes of
`projection.snapshot.scope.sourceId`, then the raw UTF-8 bytes of
`projection.snapshot.scope.threadId`, using unsigned lexicographic byte order for both
fields, then by `projection.snapshot.generation` in numeric ascending order. Two
projection records MUST NOT compare equal; a duplicate scope/generation is corrupt.
This order is independent of locale collation, Unicode normalization, insertion order,
and physical SQLite row, journal, or index order.

Head records are sorted by scope: compare the raw UTF-8 bytes of `scope.sourceId`, then
the raw UTF-8 bytes of `scope.threadId`, using unsigned lexicographic byte order. Head
ordering is likewise independent of locale collation, Unicode normalization, and
physical SQLite order.

`sequence` starts at `0` for the manifest and increases by exactly one for every
projection, head, and footer. A phase regression, gap, duplicate sequence, or reordered
record is corrupt.

## 3. Normative record schemas

`LowerHex64` is exactly 64 lowercase ASCII hexadecimal characters. `SafeInteger` is a
non-negative integer no greater than `Number.MAX_SAFE_INTEGER`. Unknown, missing, or
accessor-like fields are invalid. The following field order is canonical UTF-16 key
order:

```ts
type Manifest = {
  canonicalization: "attunegraph-canonical-json-utf16@1";
  format: "attunegraph-portable";
  formatVersion: 1;
  hashAlgorithm: "sha-256";
  kind: "manifest";
  limitsProfile: "attunegraph-portable-limits@1";
  recordId: `attunegraph-portable-record:${LowerHex64}`;
  schemaVersion: 1;
  sequence: 0;
  stateModel: "projection-journal-head@1";
};
type ProjectionRecord = {
  kind: "projection";
  projection: AttuneGraphStoredProjection;
  projectionId: `attunegraph-store:${LowerHex64}`;
  recordId: `attunegraph-portable-record:${LowerHex64}`;
  schemaVersion: 1;
  sequence: SafeInteger;
};
type HeadRecord = {
  commitId: string;
  generation: SafeInteger;
  kind: "head";
  projectionId: `attunegraph-store:${LowerHex64}`;
  recordId: `attunegraph-portable-record:${LowerHex64}`;
  schemaVersion: 1;
  scope: { sourceId: string; threadId: string };
  sequence: SafeInteger;
};
type Footer = {
  headCount: SafeInteger;
  kind: "footer";
  manifestId: `attunegraph-portable-record:${LowerHex64}`;
  priorByteLength: SafeInteger;
  priorRecordCount: SafeInteger;
  projectionCount: SafeInteger;
  recordId: `attunegraph-portable-record:${LowerHex64}`;
  schemaVersion: 1;
  scopeCount: SafeInteger;
  sequence: SafeInteger;
  stateId: `attunegraph-state:${LowerHex64}`;
};
```

`projection` is the current `AttuneGraphStoredProjection` logical value. The package-private
portable admission seam first normalizes caller-supplied `expectedScope` through the
Engine's exact hostile-safe scope normalizer, then admits the value through the exact
shared Engine `normalizeStoredProjection` seam. This covers schema, scope, canonical
projection/content ID, metadata, assertion, snapshot commit, hostile-object, and size
checks. Portable code MUST NOT read scope from the supplied projection first or
substitute the weaker local Worker parser.

`projectionId` is the `storeEnvelopeId` validated or minted by that exact admission
path. The ID is:

```text
"attunegraph-store:"
+ sha256(
    utf8("attunegraph.store-projection.v1")
    || 0x00
    || unsignedStoredProjectionCanonicalJson
  ).lowerHex
```

Here `unsignedStoredProjectionCanonicalJson` is the canonical JSON body without
`storeEnvelopeId`. A supplied `storeEnvelopeId` is valid only when it equals the minted
value. A `ProjectionRecord.projectionId` MUST equal that value.

Each head names an already-seen projection and MUST equal the one exact final
`(generation, commitId, projectionId)` for its scope. There is exactly one head per scope;
duplicate, missing, or substituted heads are corrupt. Therefore `headCount` equals
`scopeCount`.

The footer counts MUST be exact:

- `projectionCount` is the number of projection records.
- `headCount` is the number of head records.
- `scopeCount` is the number of distinct head scopes.
- `priorRecordCount = 1 + projectionCount + headCount`.
- `priorByteLength` is the byte length of the exact manifest, projection, and head line
  bytes, including each LF.
- footer `sequence = priorRecordCount`.
- total record count is `priorRecordCount + 1`, including manifest and footer.
- `manifestId` equals the manifest `recordId`.

## 4. Record and state identities

All hashes are SHA-256 over exact bytes and are rendered as lowercase hexadecimal. Domain
and payload are separated by one NUL byte. There is no length prefix, textual hex input,
or platform newline substitution.

For every record:

```text
recordId =
  "attunegraph-portable-record:"
  + sha256(
      utf8("attunegraph.portable-record.v1")
      || 0x00
      || utf8(canonicalJson(record without recordId))
    ).lowerHex
```

For the artifact state:

```text
stateId =
  "attunegraph-state:"
  + sha256(
      utf8("attunegraph.portable-state.v1")
      || 0x00
      || exact manifest/projection/head line bytes
    ).lowerHex
```

The state payload includes every manifest, projection, and head LF. It excludes the
footer line in full. The footer is likewise excluded from `priorRecordCount` and
`priorByteLength`. The footer's own `recordId`, computed after `stateId` and all footer
counts are present, binds the complete footer. The report `exportId` is the footer
`recordId`.

## 5. Fixed `attunegraph-portable-limits@1` limits

These are independent axes and MUST be checked independently:

| Axis | Exact maximum |
| --- | ---: |
| Projection records | `1_000_000` |
| Head records | `1_000_000` |
| Scopes | `1_000_000` |
| Total records, including manifest/footer | `2_000_002` |
| Unsigned stored-projection canonical body | `1_048_256` bytes |
| Minted-ID full stored-projection envelope | `1_048_576` bytes |
| Portable record line, excluding LF | `1_114_112` bytes |
| Manifest or footer line, excluding LF | `16_384` bytes |
| Entire artifact | `1_099_511_627_776` bytes |
| JSON depth | `12` |
| Descriptors per projection | `32_768` |
| One string | `16_384` UTF-16 code units |
| One string | `16_384` UTF-8 bytes |
| Aggregate projection string bytes | `1_000_000` |
| Recommended transport chunk | `262_144` bytes |

The unsigned-body limit, minted-ID full-envelope limit, and portable-line limit are three
different measurements. An implementation MUST NOT use one as a substitute for another.
The transport chunk size is a recommendation, not permission to split or relax a line.

The encoder's package-internal qualification seam exercises this same production implementation
path with an immutable reduced seven-axis budget snapshot. Those tests qualify exact boundary,
precedence, retry, and terminal-abort behavior without allocating production-scale artifacts.
Synthetic head/count sinks in those tests are boundary-only and are not format-valid corpus
claims; the unchanged checked-in golden suite remains the authority for exact-head integration.
The qualification does **not** claim 100,000- or 1,000,000-record execution, execution at the
1 TiB artifact ceiling, empirical memory or event-loop behavior, decoder compatibility, or
compatibility with a second runtime.

## 6. Streaming decoder and validation sink

The codec, excluding its sink, MUST use `O(max-line)` memory. It may retain the current
line, incremental byte/count/hash state, manifest identity, and fixed counters; it MUST
NOT retain every projection or head in memory.

Ordered identity and final-state validation belong to an external validation sink:

```ts
interface AttuneGraphPortableValidationSink {
  appendProjection(identity: AttuneGraphPortableProjectionIdentity): void | Promise<void>;
  sealProjections(): void | Promise<void>;
  assertHead(head: HeadRecord): void | Promise<void>;
  finish(expectedScopeCount: number, expectedHeadCount: number): void | Promise<void>;
  abort(cause: unknown): void | Promise<void>;
}
```

- `appendProjection(identity)` records each normalized projection's ordered identity,
  including its exact scope, generation, commit ID, and projection ID, in external or
  otherwise bounded state.
- `sealProjections()` closes the projection phase before any head is accepted.
- `assertHead(head)` verifies that the scope matches exactly once and that
  `(generation, commitId, projectionId)` is its exact final projection state.
- `finish(expectedScopeCount, expectedHeadCount)` rejects missing, substituted, or
  duplicate heads and count mismatches.
- `abort(cause)` discards all partial sink state on every parse, validation, timeout, or
  I/O failure.

The `O(max-line)` claim excludes sink storage. The package-private indexed sink
supplies transactional SQLite staging and exact final-head validation, while a
separate POSIX lifecycle owns its staging files.
A later Admin operation still publishes a destination generation only after decoder,
sink, and staging completion. An exporter is expected to use a
pinned ordered cursor so concurrent source changes cannot mix states in one artifact.
A future encoder MUST accept caller-supplied `expectedScope` for every projection and a
mandatory exact-head validation sink; it must not infer scope from an unadmitted value or
make head validation optional.

## 7. `./admin` public contract and future transfer operations

`@attunegraph/core/admin` now ships a deliberately smaller offline read-only
Interface: `openAttuneGraphAdminReadonlyApplication` plus its bounded summary,
integrity, exact-head, error, options, application, and scope contracts. It
requires an explicitly closed/quiescent source and exposes no filesystem,
SQLite, Worker, snapshot, inspector, export, rebuild, or mutation capability.

The journal-transfer contract below remains normative future design. These
transfer functions, report, error class, and codes are not exported.

```ts
interface ExportLocalAttuneGraphJournalOptions {
  readonly databasePath: string;
  readonly exportPath: string;
}
interface RebuildLocalAttuneGraphJournalOptions {
  readonly exportPath: string;
  readonly databasePath: string;
}
interface AttuneGraphJournalTransferReport {
  readonly format: "attunegraph-portable";
  readonly formatVersion: 1;
  readonly stateId: `attunegraph-state:${string}`;
  readonly exportId: `attunegraph-portable-record:${string}`;
  readonly scopes: number;
  readonly projections: number;
  readonly bytes: number;
}
type AttuneGraphJournalTransferErrorCode =
  | "INVALID_INPUT"
  | "CORRUPT_SOURCE"
  | "CORRUPT_PORTABLE_EXPORT"
  | "FUTURE_PORTABLE_EXPORT"
  | "DESTINATION_EXISTS"
  | "UNSUPPORTED_PROFILE"
  | "OPERATION_FAILED"
  | "TIMED_OUT";
```

The future operations are
`exportLocalAttuneGraphJournal(options): Promise<AttuneGraphJournalTransferReport>` and
`rebuildLocalAttuneGraphJournal(options): Promise<AttuneGraphJournalTransferReport>`. Their future
`AttuneGraphJournalTransferError` class and `AttuneGraphJournalTransferErrorCode` remain `./admin`-only.
They MUST NOT widen the root `AttuneGraphErrorCode`.

In both reports, `scopes` and `projections` equal the validated footer counts and `bytes`
is the complete artifact byte length, including every LF and the footer line.

The default maintenance deadline is exactly 120 seconds. Portable v1 does not expose it
as a public option. Failures use this precedence:

1. option shape and distinct normalized source/destination paths;
2. destination collision;
3. source profile and existence;
4. source database or portable artifact semantics;
5. I/O and atomic publish.

Export treats `databasePath` as source and `exportPath` as destination. Rebuild treats
`exportPath` as source and `databasePath` as destination. A pre-existing destination is
never overwritten.

After timeout or Worker exit, the target is either absent or a fully valid, atomically
published destination. The outcome is nevertheless unknown to the caller until the
destination is inspected. A caller MUST NOT blindly retry by overwriting an existing
target; it must validate or choose a distinct destination.
