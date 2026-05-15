import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerFeedsCommand, slugifyUrl } from "./commands-feeds.js";

describe("slugifyUrl (goal 185)", () => {
  it("strips the http(s) / file scheme prefix", () => {
    expect(slugifyUrl("https://example.com/feed.xml")).toBe("example.com-feed.xml");
    expect(slugifyUrl("http://example.com/rss")).toBe("example.com-rss");
    expect(slugifyUrl("file:///tmp/local.atom")).toBe("tmp-local.atom");
  });

  it("collapses runs of non [A-Za-z0-9._-] into a single dash", () => {
    expect(slugifyUrl("https://news.example.com/a//b???c")).toBe("news.example.com-a-b-c");
  });

  it("trims leading/trailing dashes left by sanitisation", () => {
    expect(slugifyUrl("https://example.com/?q=1")).toBe("example.com-q-1");
    expect(slugifyUrl("https://%%%/")).toBe("feed");
  });

  it("caps the slug at 60 chars", () => {
    const long = `https://example.com/${"path/".repeat(40)}`;
    expect(slugifyUrl(long).length).toBeLessThanOrEqual(60);
  });

  it("falls back to 'feed' when stripping leaves nothing", () => {
    expect(slugifyUrl("https://")).toBe("feed");
    expect(slugifyUrl("file://")).toBe("feed");
    expect(slugifyUrl("")).toBe("feed");
  });

  it("preserves a clean host+path verbatim (dots/dashes/underscores kept)", () => {
    expect(slugifyUrl("https://my-blog.example.org/feeds_main.rss"))
      .toBe("my-blog.example.org-feeds_main.rss");
  });
});

async function runFeedsCommand(
  args: readonly string[],
  feedsFile: string
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io = {
    stdout: (msg: string) => stdoutChunks.push(msg),
    stderr: (msg: string) => stderrChunks.push(msg)
  };
  const previous = process.env.MUSE_FEEDS_FILE;
  const previousExit = process.exitCode;
  process.env.MUSE_FEEDS_FILE = feedsFile;
  process.exitCode = 0;
  try {
    const program = new Command();
    registerFeedsCommand(program, io);
    await program.parseAsync(["node", "muse", "feeds", ...args]);
  } finally {
    if (previous === undefined) delete process.env.MUSE_FEEDS_FILE;
    else process.env.MUSE_FEEDS_FILE = previous;
  }
  const exitCode = process.exitCode;
  process.exitCode = previousExit;
  return { exitCode, stderr: stderrChunks.join(""), stdout: stdoutChunks.join("") };
}

function seedFeeds(ids: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-feeds-typo-"));
  const file = join(dir, "feeds.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      feeds: ids.map((id) => ({
        id,
        url: `https://example.com/${id}.xml`,
        name: id,
        lastFetchedAt: "2026-05-15T00:00:00Z",
        entries: []
      }))
    }),
    "utf8"
  );
  return file;
}

describe("muse feeds remove typo hint (goal 153)", () => {
  it("fuzzy-suggests the closest known id when the input mistypes", async () => {
    const file = seedFeeds(["tech_news", "weather", "hn-front"]);
    const { stdout, stderr, exitCode } = await runFeedsCommand(["remove", "tech-news"], file);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("no feed with id 'tech-news'");
    expect(stderr).toContain("did you mean 'tech_news'");
    expect(stderr).toContain("muse feeds list");
  });

  it("omits the 'did you mean' clause when no candidate is close enough", async () => {
    const file = seedFeeds(["tech_news", "weather"]);
    const { stderr, exitCode } = await runFeedsCommand(["remove", "zzzzz"], file);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no feed with id 'zzzzz'");
    expect(stderr).not.toContain("did you mean");
  });

  it("removes the feed cleanly on an exact match (no hint path)", async () => {
    const file = seedFeeds(["tech_news", "weather"]);
    const { stdout, stderr, exitCode } = await runFeedsCommand(["remove", "weather"], file);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Removed feed 'weather'");
  });
});

describe("muse feeds refresh --id typo hint (goal 153)", () => {
  it("fuzzy-suggests the closest known id when --id mistypes", async () => {
    const file = seedFeeds(["tech_news", "weather"]);
    const { stderr, exitCode } = await runFeedsCommand(["refresh", "--id", "weater"], file);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no feed with id 'weater'");
    expect(stderr).toContain("did you mean 'weather'");
  });
});
