import { describe, expect, it } from "vitest";

import { createFilesystemMcpServer, utf8SafeSliceEnd } from "../src/loopback-filesystem.js";

describe("utf8SafeSliceEnd — trims to maxBytes on a character boundary (no mid-codepoint cut)", () => {
  it("returns the whole buffer when it fits", () => {
    const buf = Buffer.from("hello");
    expect(utf8SafeSliceEnd(buf, 50).toString("utf8")).toBe("hello");
  });

  it("backs a cut that lands mid-character off to the previous boundary (Korean, 3 bytes/char)", () => {
    const buf = Buffer.from("가나다라"); // 12 bytes, 3 each
    // 8 lands inside "다" (bytes 6-8) → back off to end of "나" (byte 6)
    expect(utf8SafeSliceEnd(buf, 8).toString("utf8")).toBe("가나");
    expect(utf8SafeSliceEnd(buf, 8).toString("utf8")).not.toContain("�");
  });

  it("keeps a char that ends exactly on the cap (exact boundary)", () => {
    const buf = Buffer.from("가나다라");
    expect(utf8SafeSliceEnd(buf, 6).toString("utf8")).toBe("가나"); // byte 6 is a lead byte
  });

  it("handles a 4-byte emoji straddling the cap", () => {
    const buf = Buffer.from("ab😀cd"); // 'a''b' = 2, 😀 = 4 (bytes 2-5), 'c''d' = 2
    expect(utf8SafeSliceEnd(buf, 4).toString("utf8")).toBe("ab"); // 4 lands inside the emoji
    expect(utf8SafeSliceEnd(buf, 6).toString("utf8")).toBe("ab😀"); // emoji fully fits
  });

  it("does NOT touch an ASCII cut (byte boundary == char boundary)", () => {
    const buf = Buffer.from("x".repeat(200));
    expect(utf8SafeSliceEnd(buf, 50).toString("utf8")).toBe("x".repeat(50));
  });

  it("returns empty for a non-positive cap", () => {
    expect(utf8SafeSliceEnd(Buffer.from("가"), 0).byteLength).toBe(0);
  });
});

const ALLOWED_ROOT = "/workspace";

function findTool(server: ReturnType<typeof createFilesystemMcpServer>, name: string) {
  const tool = server.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' not found`);
  return tool;
}

function makeFs(opts: {
  realpath?: (p: string) => Promise<string>;
  fileContent?: string;
} = {}) {
  const content = opts.fileContent ?? "secret content";
  return {
    readFile: async (_p: string) => Buffer.from(content),
    readdir: async (_p: string, _opts: { withFileTypes: true }) => [] as readonly { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[],
    stat: async (_p: string) => ({
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
      mtime: new Date(),
      size: content.length
    }),
    ...(opts.realpath !== undefined ? { realpath: opts.realpath } : {})
  };
}

describe("loopback-filesystem — symlink escape prevention (realpath guard)", () => {
  describe("read tool", () => {
    it("refuses a path whose realpath escapes the allowed root (symlink escape)", async () => {
      const escapingFs = {
        ...makeFs({ fileContent: "root:x:0:0:root:/root:/bin/sh\n" }),
        realpath: async (p: string) =>
          p === `${ALLOWED_ROOT}/escape` ? "/etc/passwd" : p
      };

      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: escapingFs
      });
      const tool = findTool(server, "read");
      const result = await tool.execute({ path: `${ALLOWED_ROOT}/escape` }) as Record<string, unknown>;

      expect(result).toHaveProperty("error");
      expect(result).not.toHaveProperty("content");
    });

    it("allows a path whose realpath stays inside the allowed root", async () => {
      const normalFs = {
        ...makeFs({ fileContent: "hello world" }),
        realpath: async (p: string) => p
      };

      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: normalFs
      });
      const tool = findTool(server, "read");
      const result = await tool.execute({ path: `${ALLOWED_ROOT}/notes.txt` }) as Record<string, unknown>;

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("content", "hello world");
    });

    it("refuses when realpath throws (e.g. dangling symlink — fail-closed)", async () => {
      const danglingFs = {
        ...makeFs(),
        realpath: async (_p: string) => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }
      };

      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: danglingFs
      });
      const tool = findTool(server, "read");
      const result = await tool.execute({ path: `${ALLOWED_ROOT}/dangling` }) as Record<string, unknown>;

      expect(result).toHaveProperty("error");
      expect(result).not.toHaveProperty("content");
    });
  });

  describe("list tool", () => {
    it("refuses a directory path whose realpath escapes the allowed root", async () => {
      const escapingFs = {
        ...makeFs(),
        realpath: async (p: string) =>
          p === `${ALLOWED_ROOT}/escape-dir` ? "/etc" : p
      };

      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: escapingFs
      });
      const tool = findTool(server, "list");
      const result = await tool.execute({ path: `${ALLOWED_ROOT}/escape-dir` }) as Record<string, unknown>;

      expect(result).toHaveProperty("error");
      expect(result).not.toHaveProperty("entries");
    });

    it("allows a directory whose realpath stays inside the allowed root", async () => {
      const normalFs = {
        ...makeFs(),
        realpath: async (p: string) => p
      };

      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: normalFs
      });
      const tool = findTool(server, "list");
      const result = await tool.execute({ path: `${ALLOWED_ROOT}/subdir` }) as Record<string, unknown>;

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("entries");
    });
  });

  describe("stat tool", () => {
    it("refuses a path whose realpath escapes the allowed root", async () => {
      const escapingFs = {
        ...makeFs(),
        realpath: async (p: string) =>
          p === `${ALLOWED_ROOT}/stat-escape` ? "/etc/shadow" : p
      };

      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: escapingFs
      });
      const tool = findTool(server, "stat");
      const result = await tool.execute({ path: `${ALLOWED_ROOT}/stat-escape` }) as Record<string, unknown>;

      expect(result).toHaveProperty("error");
      expect(result).not.toHaveProperty("kind");
    });

    it("allows a path whose realpath stays inside the allowed root", async () => {
      const normalFs = {
        ...makeFs(),
        realpath: async (p: string) => p
      };

      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: normalFs
      });
      const tool = findTool(server, "stat");
      const result = await tool.execute({ path: `${ALLOWED_ROOT}/file.txt` }) as Record<string, unknown>;

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("kind");
    });

    it("reports a symlink as kind=symlink WITHOUT following it (honors the documented contract)", async () => {
      // The path IS a symlink: lstat sees the link, stat would follow it to a file.
      // The tool must use lstat so it reports kind=symlink, as its description promises.
      const symlinkFs = {
        ...makeFs(),
        lstat: async (_p: string) => ({
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
          mtime: new Date(),
          size: 0
        }),
        realpath: async (p: string) => p
      };
      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: symlinkFs
      });
      const tool = findTool(server, "stat");
      const result = await tool.execute({ path: `${ALLOWED_ROOT}/link` }) as Record<string, unknown>;

      expect(result).not.toHaveProperty("error");
      expect(result.kind).toBe("symlink"); // NOT "file" (which stat-follow would yield)
    });
  });

  describe("lexical allowlist still gates paths not under any root", () => {
    it("a path outside the root is still refused even when no realpath dep is provided", async () => {
      const server = createFilesystemMcpServer({
        allowedRoots: [ALLOWED_ROOT],
        fs: makeFs()
      });
      const tool = findTool(server, "read");
      const result = await tool.execute({ path: "/etc/passwd" }) as Record<string, unknown>;

      expect(result).toHaveProperty("error");
      expect(result).not.toHaveProperty("content");
    });
  });
});
