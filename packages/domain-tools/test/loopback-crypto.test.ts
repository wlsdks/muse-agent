import { describe, expect, it } from "vitest";

import { createCryptoMcpServer } from "../src/loopback-crypto.js";

const tool = (name: string) => {
  const found = createCryptoMcpServer().tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
};

describe("muse.crypto.hash", () => {
  it("defaults to sha256 hex and matches known-answer vectors", async () => {
    expect(await tool("hash").execute({ text: "abc" })).toMatchObject({
      algorithm: "sha256",
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      encoding: "hex",
    });
    expect(await tool("hash").execute({ text: "" })).toMatchObject({
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("supports md5 / sha1 and is case-insensitive on the algorithm name", async () => {
    expect(await tool("hash").execute({ text: "abc", algorithm: "md5" })).toMatchObject({
      digest: "900150983cd24fb0d6963f7d28e17f72",
    });
    expect(await tool("hash").execute({ text: "abc", algorithm: "SHA1" })).toMatchObject({
      algorithm: "sha1",
      digest: "a9993e364706816aba3e25717850c26c9cd0d89d",
    });
  });

  it("emits base64 digests on request", async () => {
    expect(await tool("hash").execute({ text: "abc", encoding: "base64" })).toMatchObject({
      digest: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
      encoding: "base64",
    });
  });

  it("rejects an unsupported algorithm, a bad encoding, and missing text", async () => {
    expect(await tool("hash").execute({ text: "x", algorithm: "sha3" })).toMatchObject({
      error: expect.stringContaining("algorithm must be one of"),
    });
    expect(await tool("hash").execute({ text: "x", encoding: "base32" })).toMatchObject({
      error: "encoding must be 'hex' or 'base64'",
    });
    expect(await tool("hash").execute({})).toMatchObject({ error: "text is required" });
  });
});

describe("muse.crypto.base64", () => {
  it("encodes by default and round-trips unicode through decode", async () => {
    expect(await tool("base64").execute({ text: "hi" })).toMatchObject({ mode: "encode", output: "aGk=" });
    const encoded = (await tool("base64").execute({ text: "café🙂" })) as { output: string };
    expect(await tool("base64").execute({ text: encoded.output, mode: "decode" })).toMatchObject({
      output: "café🙂",
    });
  });

  it("rejects non-base64 charset, wrong length, and over-long padding", async () => {
    expect(await tool("base64").execute({ text: "aGk", mode: "decode" })).toMatchObject({
      error: "input is not a valid base64 string",
    });
    expect(await tool("base64").execute({ text: "aG*k", mode: "decode" })).toMatchObject({
      error: "input is not a valid base64 string",
    });
    expect(await tool("base64").execute({ text: "a===", mode: "decode" })).toMatchObject({
      error: "input is not a valid base64 string",
    });
  });

  it("rejects an unknown mode", async () => {
    expect(await tool("base64").execute({ text: "x", mode: "flip" })).toMatchObject({
      error: "mode must be 'encode' or 'decode'",
    });
  });
});

describe("muse.crypto.hex", () => {
  it("encodes to lowercase hex and round-trips through decode", async () => {
    expect(await tool("hex").execute({ text: "hi" })).toMatchObject({ output: "6869" });
    expect(await tool("hex").execute({ text: "6869", mode: "decode" })).toMatchObject({ output: "hi" });
  });

  it("rejects odd-length and non-hex input on decode", async () => {
    expect(await tool("hex").execute({ text: "686", mode: "decode" })).toMatchObject({
      error: "input is not a valid hex string",
    });
    expect(await tool("hex").execute({ text: "68zz", mode: "decode" })).toMatchObject({
      error: "input is not a valid hex string",
    });
  });
});

describe("muse.crypto.uuid", () => {
  it("uses the injected factory for deterministic output", () => {
    const server = createCryptoMcpServer({ uuid: () => "00000000-0000-4000-8000-000000000000" });
    const uuidTool = server.tools.find((t) => t.name === "uuid");
    expect(uuidTool?.execute({})).toMatchObject({ uuid: "00000000-0000-4000-8000-000000000000" });
  });
});
