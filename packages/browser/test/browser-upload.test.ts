import { validateToolDefinitions } from "@muse/tools";
import { describe, expect, it } from "vitest";

import {
  createBrowserUploadTool,
  type BrowserApprovalGate,
  type BrowserActionDraft,
  type BrowserUploadPathValidator
} from "../src/browser-tools.js";
import type {
  BrowserController,
  BrowserUploadTargetIdentity,
  PageSnapshot,
  SnapshotElement,
  WaitCondition,
  WaitOutcome
} from "../src/controller.js";

const ctx = { runId: "r", userId: "u1" };

const SNAP: PageSnapshot = {
  elements: [
    { name: "Attach resume", ref: 7, role: "button" },
    { name: "Upload file", ref: 9, role: "button" }
  ],
  text: "apply here",
  title: "Job application",
  url: "https://jobs.example.test/apply"
};

/**
 * Contract-faithful fake: it RESOLVES refs to elements the way the real
 * controller does and records uploadFile calls — but a ref that is NOT a file
 * input throws from uploadFile (the real puppeteer wrapper does the same after
 * checking the element). Tests never inject a ref the real resolver couldn't
 * produce (fire-8 lesson).
 */
class FakeController implements BrowserController {
  uploads: Array<{ ref: number; path: string }> = [];
  reads: string[] = [];
  url = SNAP.url;
  targetName = "upload";
  retainedCleanups: Array<() => Promise<void>> = [];
  beforeUploadBoundary?: () => void;
  /** Which refs are genuine <input type=file> elements. */
  fileInputs = new Set<number>([7]);
  private readonly elements = new Map<number, SnapshotElement>([
    [7, { name: "Attach resume", ref: 7, role: "button" }],
    [9, { name: "Upload file", ref: 9, role: "button" }]
  ]);
  async open(): Promise<PageSnapshot> { return SNAP; }
  async snapshot(): Promise<PageSnapshot> { return SNAP; }
  async click(): Promise<PageSnapshot> { return SNAP; }
  async hover(): Promise<PageSnapshot> { return SNAP; }
  async pressKey(): Promise<PageSnapshot> { return SNAP; }
  async type(): Promise<PageSnapshot> { return SNAP; }
  async inspectUploadTarget(ref: number) {
    return {
      accept: ".pdf",
      disabled: false,
      fileInput: this.fileInputs.has(ref),
      frameUrl: this.url,
      hidden: true,
      id: "resume-file",
      multiple: false,
      name: this.targetName,
      pageUrl: this.url,
      ref,
      selector: `[data-muse-ref="${ref.toString()}"]`
    };
  }
  async uploadFile(
    ref: number,
    path: string,
    expectedTarget?: BrowserUploadTargetIdentity,
    releaseSource?: () => Promise<void>
  ): Promise<PageSnapshot> {
    try {
      if (!this.fileInputs.has(ref)) {
        throw new Error(`element ref ${ref.toString()} is not a file input`);
      }
      this.beforeUploadBoundary?.();
      const currentTarget = await this.inspectUploadTarget(ref);
      if (expectedTarget && JSON.stringify(currentTarget) !== JSON.stringify(expectedTarget)) {
        throw new Error("upload field identity changed at the controller boundary");
      }
      this.uploads.push({ path, ref });
      if (releaseSource) this.retainedCleanups.push(releaseSource);
      return SNAP;
    } catch (cause) {
      await releaseSource?.();
      throw cause;
    }
  }
  async back(): Promise<PageSnapshot> { return SNAP; }
  async scroll(): Promise<PageSnapshot> { return SNAP; }
  waitOutcome: WaitOutcome = { matched: true, snapshot: SNAP };
  async waitFor(_c: WaitCondition): Promise<WaitOutcome> { return this.waitOutcome; }
  async screenshot(path: string): Promise<{ readonly path: string }> { return { path }; }
  async screenshotBase64(): Promise<string> { return "aW1n"; }
  describeElement(ref: number): SnapshotElement | undefined { return this.elements.get(ref); }
  currentUrl(): string { return this.url; }
  async hasOpenPage(): Promise<boolean> { return true; }
  async disconnect(): Promise<void> {
    await Promise.all(this.retainedCleanups.splice(0).map((cleanup) => cleanup()));
  }
  async close(): Promise<void> {
    await this.disconnect();
  }
}

const allow: BrowserApprovalGate = () => ({ approved: true });
const deny: BrowserApprovalGate = () => ({ approved: false, reason: "user did not confirm" });
const FILE_IDENTITY = {
  bytes: 12,
  changedAtMs: 4,
  device: 1,
  inode: 2,
  modifiedAtMs: 3,
  sha256: "a".repeat(64)
};

/** A validator that allows ONLY paths under /home/u/Downloads — records every path it was asked about. */
function rootedValidator(): BrowserUploadPathValidator & { checked: string[] } {
  const checked: string[] = [];
  const fn = (async (path: string) => {
    checked.push(path);
    if (path.startsWith("/home/u/Downloads/")) {
      return {
        allowed: true,
        cleanup: async () => {},
        identity: FILE_IDENTITY,
        resolvedPath: path,
        uploadPath: `${path}.staged`
      } as const;
    }
    return { allowed: false, reason: `'${path}' is outside the readable folders` } as const;
  }) as BrowserUploadPathValidator & { checked: string[] };
  fn.checked = checked;
  return fn;
}

describe("browser_upload — definition", () => {
  it("is validateToolDefinitions-clean, execute risk, browser domain, target+path required", () => {
    const c = new FakeController();
    const tool = createBrowserUploadTool({ approvalGate: allow, controller: c, validatePath: rootedValidator() });
    expect(tool.definition.name).toBe("browser_upload");
    expect(tool.definition.domain).toBe("browser");
    expect(tool.definition.risk).toBe("execute");
    expect(tool.definition.inputSchema.required).toEqual(expect.arrayContaining(["target", "path"]));
    expect(validateToolDefinitions([tool])).toEqual([]);
  });
});

describe("browser_upload — guard rejects path: no read, no upload", () => {
  it("a path outside the allowlist is refused — zero uploadFile, clear error, gate never reached", async () => {
    const c = new FakeController();
    const validator = rootedValidator();
    let gateCalls = 0;
    const countingGate: BrowserApprovalGate = () => { gateCalls += 1; return { approved: true }; };
    const tool = createBrowserUploadTool({ approvalGate: countingGate, controller: c, validatePath: validator });
    const out = await tool.execute({ path: "/home/u/.ssh/id_rsa", target: "Attach resume" }, ctx) as Record<string, unknown>;
    expect(out["uploaded"]).toBe(false);
    expect(String(out["reason"])).toMatch(/outside the readable folders/);
    // The sensitive path was validated and REJECTED — and never reached the
    // controller (no uploadFile, so the file is never opened/read) nor the gate.
    expect(validator.checked).toEqual(["/home/u/.ssh/id_rsa"]);
    expect(c.uploads).toEqual([]);
    expect(gateCalls).toBe(0);
  });
});

describe("browser_upload — fail-closed default when no validator wired", () => {
  it("without an injected validator the upload is refused — no read, no act", async () => {
    const c = new FakeController();
    // Deps with validatePath omitted: the tool must fail closed (never allow-all).
    const tool = createBrowserUploadTool({ approvalGate: allow, controller: c } as never);
    const out = await tool.execute({ path: "/home/u/Downloads/resume.pdf", target: "Attach resume" }, ctx) as Record<string, unknown>;
    expect(out["uploaded"]).toBe(false);
    expect(String(out["reason"])).toMatch(/no path validator|fail-closed/i);
    expect(c.uploads).toEqual([]);
  });
});

describe("browser_upload — non-file-input target fails closed", () => {
  it("a target that resolves to a non-file element does not upload (zero act)", async () => {
    const c = new FakeController();
    const validator = rootedValidator();
    const tool = createBrowserUploadTool({ approvalGate: allow, controller: c, validatePath: validator });
    // ref 9 ("Upload file") is NOT a file input in the fake — the real wrapper
    // throws when setInputFiles hits a non-file element. The allowed path was
    // validated, the gate approved, but the controller refuses the act.
    const out = await tool.execute({ path: "/home/u/Downloads/resume.pdf", target: "Upload file" }, ctx) as Record<string, unknown>;
    expect(out["uploaded"]).toBe(false);
    expect(String(out["reason"])).toMatch(/not an enabled file input/);
    expect(c.uploads).toEqual([]);
  });
});

describe("browser_upload — deny ⇒ zero setInputFiles", () => {
  it("a denied approval performs no upload even with an allowed path + real file input", async () => {
    const c = new FakeController();
    const validator = rootedValidator();
    const tool = createBrowserUploadTool({ approvalGate: deny, controller: c, validatePath: validator });
    const out = await tool.execute({ path: "/home/u/Downloads/resume.pdf", target: "Attach resume" }, ctx) as Record<string, unknown>;
    expect(out["uploaded"]).toBe(false);
    expect(String(out["reason"])).toMatch(/did not confirm/);
    expect(c.uploads).toEqual([]);
  });
});

describe("browser_upload — approval draft shows the path AND the resolved field", () => {
  it("the draft carries action=upload, the resolved file-input label, and the file path", async () => {
    const c = new FakeController();
    const validator = rootedValidator();
    let seen: BrowserActionDraft | undefined;
    const capturingGate: BrowserApprovalGate = (draft) => { seen = draft; return { approved: true }; };
    const tool = createBrowserUploadTool({ approvalGate: capturingGate, controller: c, validatePath: validator });
    await tool.execute({ path: "/home/u/Downloads/resume.pdf", target: "Attach resume" }, ctx);
    expect(seen?.action).toBe("upload");
    expect(seen?.target).toContain("Attach resume");
    expect(seen?.path).toBe("/home/u/Downloads/resume.pdf");
    expect(seen?.url).toBe("https://jobs.example.test/apply");
    expect(seen?.origin).toBe("https://jobs.example.test");
    expect(seen?.file).toEqual({ bytes: 12, sha256: "a".repeat(64) });
    expect(seen?.uploadTarget).toMatchObject({
      fileInput: true,
      id: "resume-file",
      name: "upload"
    });
  });
});

describe("browser_upload — confirmed + allowed path ⇒ setInputFiles with the RESOLVED path", () => {
  it("uploads the validator's resolvedPath (not the raw arg) to the resolved file input", async () => {
    const c = new FakeController();
    // A validator that canonicalises the path (symlink realpath) returns a
    // DIFFERENT resolvedPath — the controller must receive the canonical one.
    const validator = (async (path: string) => ({
      allowed: true,
      cleanup: async () => {},
      identity: FILE_IDENTITY,
      resolvedPath: `${path}.real`,
      uploadPath: `${path}.staged`
    })) as BrowserUploadPathValidator;
    const tool = createBrowserUploadTool({ approvalGate: allow, controller: c, validatePath: validator });
    const out = await tool.execute({ path: "/home/u/Downloads/resume.pdf", target: "Attach resume" }, ctx) as Record<string, unknown>;
    expect(out["uploaded"]).toBe(true);
    expect(c.uploads).toEqual([{ path: "/home/u/Downloads/resume.pdf.staged", ref: 7 }]);
    expect(out["authorityReceipts"]).toMatchObject({
      upload: { action: "upload", status: "performed" }
    });
  });
});

describe("browser_upload — approval-bound revalidation", () => {
  it("holds when file bytes or canonical identity change after approval", async () => {
    const c = new FakeController();
    let validations = 0;
    const validator = (async (path: string) => {
      validations += 1;
      return {
        allowed: true,
        cleanup: async () => {},
        identity: validations === 1
          ? FILE_IDENTITY
          : { ...FILE_IDENTITY, sha256: "b".repeat(64) },
        resolvedPath: path,
        uploadPath: `${path}.staged-${validations.toString()}`
      } as const;
    }) as BrowserUploadPathValidator;
    const out = await createBrowserUploadTool({
      approvalGate: allow,
      controller: c,
      validatePath: validator
    }).execute({
      path: "/home/u/Downloads/resume.pdf",
      target: "Attach resume"
    }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({
      authorityReceipts: { upload: { status: "held" } },
      uploaded: false
    });
    expect(String(out["reason"])).toMatch(/file changed after approval/u);
    expect(c.uploads).toEqual([]);
  });

  it("holds when destination origin changes during approval", async () => {
    const c = new FakeController();
    const out = await createBrowserUploadTool({
      approvalGate: () => {
        c.url = "https://evil.example.test/upload";
        return { approved: true };
      },
      controller: c,
      validatePath: rootedValidator()
    }).execute({
      path: "/home/u/Downloads/resume.pdf",
      target: "Attach resume"
    }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({
      authorityReceipts: { upload: { status: "held" } },
      uploaded: false
    });
    expect(String(out["reason"])).toMatch(/destination page changed/u);
    expect(c.uploads).toEqual([]);
  });

  it("holds when the exact upload field identity changes during approval", async () => {
    const c = new FakeController();
    const out = await createBrowserUploadTool({
      approvalGate: () => {
        c.targetName = "rewritten-field";
        return { approved: true };
      },
      controller: c,
      validatePath: rootedValidator()
    }).execute({
      path: "/home/u/Downloads/resume.pdf",
      target: "Attach resume"
    }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({
      authorityReceipts: { upload: { status: "held" } },
      uploaded: false
    });
    expect(String(out["reason"])).toMatch(/field identity changed/u);
    expect(c.uploads).toEqual([]);
  });

  it("rechecks page and field after the second async file preparation", async () => {
    for (const drift of ["page", "field"] as const) {
      const c = new FakeController();
      let validations = 0;
      const validator = (async (path: string) => {
        validations += 1;
        if (validations === 2) {
          if (drift === "page") c.url = "https://evil.example.test/upload";
          else c.targetName = "drifted-during-file-check";
        }
        return {
          allowed: true,
          cleanup: async () => {},
          identity: FILE_IDENTITY,
          resolvedPath: path,
          uploadPath: `${path}.staged-${validations.toString()}`
        } as const;
      }) as BrowserUploadPathValidator;
      const out = await createBrowserUploadTool({
        approvalGate: allow,
        controller: c,
        validatePath: validator
      }).execute({
        path: "/home/u/Downloads/resume.pdf",
        target: "Attach resume"
      }, ctx) as Record<string, unknown>;
      expect(out).toMatchObject({
        authorityReceipts: { upload: { status: "held" } },
        uploaded: false
      });
      expect(c.uploads).toEqual([]);
    }
  });

  it("the controller boundary catches a final field drift before setInputFiles", async () => {
    const c = new FakeController();
    c.beforeUploadBoundary = () => {
      c.targetName = "last-moment-drift";
    };
    const out = await createBrowserUploadTool({
      approvalGate: allow,
      controller: c,
      validatePath: rootedValidator()
    }).execute({
      path: "/home/u/Downloads/resume.pdf",
      target: "Attach resume"
    }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({
      authorityReceipts: { upload: { status: "failed" } },
      uploaded: "unknown"
    });
    expect(c.uploads).toEqual([]);
  });

  it("freezes the canonical path, file identity, and field identity shown to the gate", async () => {
    const c = new FakeController();
    let seen: BrowserActionDraft | undefined;
    await createBrowserUploadTool({
      approvalGate: (draft) => {
        seen = draft;
        expect(Object.isFrozen(draft)).toBe(true);
        expect(Object.isFrozen(draft.file)).toBe(true);
        expect(Object.isFrozen(draft.uploadTarget)).toBe(true);
        return { approved: false };
      },
      controller: c,
      validatePath: rootedValidator()
    }).execute({
      path: "/home/u/Downloads/resume.pdf",
      target: "Attach resume"
    }, ctx);
    expect(seen).toMatchObject({
      origin: "https://jobs.example.test",
      path: "/home/u/Downloads/resume.pdf"
    });
    expect(c.uploads).toEqual([]);
  });

  it("reports controller acknowledgement failure as unknown with a failed receipt", async () => {
    const c = new FakeController();
    c.uploadFile = async (_ref, _path, _expected, releaseSource) => {
      await releaseSource?.();
      throw new Error("upload acknowledgement lost");
    };
    const out = await createBrowserUploadTool({
      approvalGate: allow,
      controller: c,
      validatePath: rootedValidator()
    }).execute({
      path: "/home/u/Downloads/resume.pdf",
      target: "Attach resume"
    }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({
      authorityReceipts: { upload: { status: "failed" } },
      uploaded: "unknown"
    });
    expect(String(out["error"])).toContain("acknowledgement lost");
  });

  it("retains the stable staged source until controller release, then cleans it", async () => {
    const c = new FakeController();
    let cleanups = 0;
    const validator = (async (path: string) => ({
      allowed: true,
      cleanup: async () => {
        cleanups += 1;
      },
      identity: FILE_IDENTITY,
      resolvedPath: path,
      uploadPath: `${path}.staged`
    })) as BrowserUploadPathValidator;
    const out = await createBrowserUploadTool({
      approvalGate: allow,
      controller: c,
      validatePath: validator
    }).execute({
      path: "/home/u/Downloads/resume.pdf",
      target: "Attach resume"
    }, ctx) as Record<string, unknown>;
    expect(out["uploaded"]).toBe(true);
    // First approval snapshot is disposable; the successful second snapshot
    // remains controller-owned so the browser File stays readable for submit.
    expect(cleanups).toBe(1);
    expect(c.retainedCleanups).toHaveLength(1);
    await c.disconnect();
    expect(cleanups).toBe(2);
  });
});

describe("browser_upload — missing args", () => {
  it("missing path is refused without touching the controller or validator", async () => {
    const c = new FakeController();
    const validator = rootedValidator();
    const tool = createBrowserUploadTool({ approvalGate: allow, controller: c, validatePath: validator });
    const out = await tool.execute({ target: "Attach resume" }, ctx) as Record<string, unknown>;
    expect(out["uploaded"]).toBe(false);
    expect(String(out["reason"])).toMatch(/path/);
    expect(validator.checked).toEqual([]);
    expect(c.uploads).toEqual([]);
  });
  it("missing target is refused — validator may run for the path but no upload happens", async () => {
    const c = new FakeController();
    const validator = rootedValidator();
    const tool = createBrowserUploadTool({ approvalGate: allow, controller: c, validatePath: validator });
    const out = await tool.execute({ path: "/home/u/Downloads/resume.pdf" }, ctx) as Record<string, unknown>;
    expect(out["uploaded"]).toBe(false);
    expect(String(out["reason"])).toMatch(/target/);
    expect(c.uploads).toEqual([]);
  });
});
