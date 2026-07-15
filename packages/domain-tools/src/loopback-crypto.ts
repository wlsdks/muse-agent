import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import { createStringSetGuard } from "@muse/shared";
import type { JsonObject } from "@muse/shared";

import type { BuiltinLoopbackOptions, LoopbackMcpServer } from "@muse/mcp";
import { readString } from "@muse/mcp";

const SUPPORTED_ALGORITHMS = ["md5", "sha1", "sha256", "sha512"] as const;
const isSupportedAlgorithm = createStringSetGuard(SUPPORTED_ALGORITHMS);

/**
 * Decode bytes to a UTF-8 string, but ERROR (not silently U+FFFD-corrupt) when the
 * bytes aren't valid UTF-8. `Buffer.toString("utf8")` replaces invalid sequences with
 * the replacement char, so a base64/hex decode of BINARY data would otherwise return
 * garbled text with no signal. The re-encode round-trip detects the loss: a valid
 * UTF-8 string round-trips back to the exact bytes; a lossy one does not.
 */
function decodeBytesAsUtf8(buf: Buffer, label: "base64" | "hex"): { output: string } | { error: string } {
  const output = buf.toString("utf8");
  return Buffer.from(output, "utf8").equals(buf)
    ? { output }
    : { error: `${label} input decodes to non-UTF-8 (binary) bytes — decode returns text only` };
}

/**
 * `muse.crypto` loopback MCP server — deterministic crypto digests +
 * base64/hex encoding + RFC 4122 v4 UUIDs.
 *
 * Lifted out of `loopback.ts` (the next-biggest ambient factory after
 * regex was lifted ). Same public surface:
 * `createCryptoMcpServer(options?)`. Re-exported from `loopback.ts`
 * so the `@muse/mcp` barrel and existing tests keep working without
 * import-site edits.
 *
 * Tools:
 *   - `muse.crypto.hash`   — md5 / sha1 / sha256 / sha512 (hex / base64)
 *   - `muse.crypto.base64` — encode / decode round-trip
 *   - `muse.crypto.hex`    — encode / decode round-trip
 *   - `muse.crypto.uuid`   — v4 UUID via `options.uuid` injection or
 *     `randomUUID` fallback
 */
export function createCryptoMcpServer(options: BuiltinLoopbackOptions = {}): LoopbackMcpServer {
  return {
    description: "Built-in crypto digest and encoding utilities (loopback MCP).",
    name: "muse.crypto",
    tools: [
      {
        description:
          "Hashes the input string with the requested algorithm (md5, sha1, sha256, sha512). Returns hex digest by default; pass encoding='base64' to get base64.",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          if (text === undefined) {
            return { error: "text is required" };
          }
          const algorithm = (readString(args, "algorithm") ?? "sha256").toLowerCase();
          if (!isSupportedAlgorithm(algorithm)) {
            return { error: `algorithm must be one of ${SUPPORTED_ALGORITHMS.join(", ")}` };
          }
          const encoding = readString(args, "encoding") ?? "hex";
          if (encoding !== "hex" && encoding !== "base64") {
            return { error: "encoding must be 'hex' or 'base64'" };
          }
          try {
            const digest = createHash(algorithm).update(text, "utf8").digest(encoding);
            return { algorithm, digest, encoding } satisfies JsonObject;
          } catch (error) {
            return { error: error instanceof Error ? error.message : "hash failed" };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            algorithm: { enum: [...SUPPORTED_ALGORITHMS], type: "string" },
            encoding: { enum: ["hex", "base64"], type: "string" },
            text: { type: "string" }
          },
          required: ["text"],
          type: "object"
        },
        name: "hash",
        risk: "read"
      },
      {
        description: "Encodes the input string to base64 (mode='encode') or decodes a base64 string back to UTF-8 (mode='decode').",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          if (text === undefined) {
            return { error: "text is required" };
          }
          const mode = readString(args, "mode") ?? "encode";
          if (mode !== "encode" && mode !== "decode") {
            return { error: "mode must be 'encode' or 'decode'" };
          }
          try {
            if (mode === "encode") {
              return { mode, output: Buffer.from(text, "utf8").toString("base64") } satisfies JsonObject;
            }
            if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text) || text.length % 4 !== 0) {
              return { error: "input is not a valid base64 string" };
            }
            const result = decodeBytesAsUtf8(Buffer.from(text, "base64"), "base64");
            return "error" in result ? result : { mode, output: result.output } satisfies JsonObject;
          } catch (error) {
            return { error: error instanceof Error ? error.message : "base64 failed" };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            mode: { enum: ["encode", "decode"], type: "string" },
            text: { type: "string" }
          },
          required: ["text"],
          type: "object"
        },
        name: "base64",
        risk: "read"
      },
      {
        description: "Encodes the input string to lowercase hex (mode='encode') or decodes a hex string back to UTF-8 (mode='decode').",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          if (text === undefined) {
            return { error: "text is required" };
          }
          const mode = readString(args, "mode") ?? "encode";
          if (mode !== "encode" && mode !== "decode") {
            return { error: "mode must be 'encode' or 'decode'" };
          }
          try {
            if (mode === "encode") {
              return { mode, output: Buffer.from(text, "utf8").toString("hex") } satisfies JsonObject;
            }
            if (!/^[0-9a-fA-F]*$/u.test(text) || text.length % 2 !== 0) {
              return { error: "input is not a valid hex string" };
            }
            const result = decodeBytesAsUtf8(Buffer.from(text, "hex"), "hex");
            return "error" in result ? result : { mode, output: result.output } satisfies JsonObject;
          } catch (error) {
            return { error: error instanceof Error ? error.message : "hex failed" };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            mode: { enum: ["encode", "decode"], type: "string" },
            text: { type: "string" }
          },
          required: ["text"],
          type: "object"
        },
        name: "hex",
        risk: "read"
      },
      {
        description: "Generates a fresh RFC 4122 v4 UUID. Uses an injected idFactory for deterministic tests.",
        execute: (): JsonObject => {
          const factory = options.uuid ?? randomUUID;
          return { uuid: factory() } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        name: "uuid",
        risk: "read"
      }
    ]
  };
}
