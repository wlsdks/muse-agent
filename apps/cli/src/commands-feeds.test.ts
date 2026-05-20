import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { formatFeedEntryLines, registerFeedsCommand, slugifyUrl } from "./commands-feeds.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function hasTerminalControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x08 || (c >= 0x0b && c <= 0x1f) || c === 0x7f) return true;
  }
  return false;
}

describe("formatFeedEntryLines (goal 346 sibling — feeds)", () => {
  it("strips terminal control sequences from third-party feed fields", () => {
    const lines = formatFeedEntryLines({
      feedId: "news",
      title: `${ESC}[2J${ESC}]0;pwned${BEL}Breaking: hostile feed`,
      link: `https://x.example/${ESC}[31m`,
      publishedAt: "2026-05-18"
    });
    const joined = lines.join("\n");
    expect(hasTerminalControl(joined)).toBe(false);
    expect(joined).toContain("Breaking: hostile feed");
    expect(joined).toContain("[news]");
    expect(joined).toContain("2026-05-18");
  });

  it("collapses newlines and falls back to (no date)", () => {
    const lines = formatFeedEntryLines({
      feedId: "f1",
      title: "multi\nline\ntitle",
      link: "",
      publishedAt: "   "
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[f1] multi line title — (no date)");
  });

  it("leaves a clean entry untouched (no regression)", () => {
    expect(formatFeedEntryLines({
      feedId: "hn",
      title: "Show HN: a thing",
      link: "https://news.example/1",
      publishedAt: "2026-05-18T09:00:00Z"
    })).toEqual([
      "[hn] Show HN: a thing — 2026-05-18T09:00:00Z",
      "  https://news.example/1"
    ]);
  });
});

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

describe("muse feeds add --id empty / whitespace fallback", () => {
  function seedEmptyStore(): string {
    const dir = mkdtempSync(join(tmpdir(), "muse-feeds-add-"));
    const file = join(dir, "feeds.json");
    writeFileSync(file, JSON.stringify({ version: 1, feeds: [] }), "utf8");
    return file;
  }

  function writeFeedXml(): string {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><item><title>t</title><link>http://example.com/x</link></item></channel></rss>`;
    const dir = mkdtempSync(join(tmpdir(), "muse-feed-body-"));
    const path = join(dir, "feed.xml");
    writeFileSync(path, xml, "utf8");
    return path;
  }

  it("falls back to the slugified URL when --id is whitespace-only (no empty-id feeds in the store)", async () => {
    const store = seedEmptyStore();
    const body = writeFeedXml();
    const url = `file://${body}`;
    const { exitCode } = await runFeedsCommand(["add", url, "--id", "   "], store);
    expect(exitCode).toBe(0);
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).not.toMatch(/^\s\t/u);
    expect(stdout).toContain(slugifyUrl(url));
  });

  it("uses --id verbatim (trimmed) when non-empty", async () => {
    const store = seedEmptyStore();
    const body = writeFeedXml();
    const { exitCode } = await runFeedsCommand(["add", `file://${body}`, "--id", "  custom-alias  "], store);
    expect(exitCode).toBe(0);
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).toContain("custom-alias");
  });

  it("rejects a whitespace-only URL with an actionable error instead of a confusing fetch failure", async () => {
    const store = seedEmptyStore();
    const { stderr, exitCode } = await runFeedsCommand(["add", "   "], store);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("muse feeds add: feed URL must be non-empty");
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).toContain("(no feeds");
  });

  it("trims a padded URL before fetching + persisting so the store doesn't keep extra whitespace", async () => {
    const store = seedEmptyStore();
    const body = writeFeedXml();
    const { exitCode } = await runFeedsCommand(["add", `  file://${body}  `, "--id", "padded"], store);
    expect(exitCode).toBe(0);
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).toContain("padded");
    expect(stdout).toContain(`file://${body}`);
    expect(stdout).not.toContain(`  file://`);
  });
});
