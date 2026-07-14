/**
 * `muse ask --with-tools` extra-tool wiring, lifted out of the commands-ask
 * god-file: the gated actuator tools (`--actuators`), the default browser-
 * control tools, the @muse/fs read/write suite + web_download, and the
 * messaging draft-first approval gate. All of it is conditional on
 * `options.withTools` / `options.actuators` and independent of retrieval,
 * grounding, or the model/assembly (which are built AFTER this).
 */

import type { MessageApprovalGate } from "@muse/domain-tools";
import type { MuseEnvironment } from "@muse/autoconfigure";
import { resolvePendingApprovalsFile } from "@muse/autoconfigure";
import type { MuseTool } from "@muse/tools";

import type { AskOptions } from "./ask-command-options.js";
import type { ProgramIO } from "./program.js";

export type ScreenVisionHolder = {
  current?: (input: { readonly imageBase64: string; readonly mimeType: string; readonly question?: string }) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>;
};

export interface AskToolWiring {
  readonly extraTools: MuseTool[] | undefined;
  readonly messagingApprovalGate: MessageApprovalGate | undefined;
  readonly browserControllerToRelease: { disconnect(): Promise<void> } | undefined;
  readonly screenVision: ScreenVisionHolder;
  /** Whether the gated actuator tools were injected — the caller also uses this to mark the runtime metadata `localMode`. */
  readonly useActuators: boolean;
}

export async function buildAskToolWiring(params: {
  readonly io: ProgramIO;
  readonly options: AskOptions;
  readonly userKey: string;
}): Promise<AskToolWiring> {
  const { io, options, userKey } = params;

  // `--actuators` (only meaningful with --with-tools) injects the gated
  // state-changing actuator tools, each carrying a clack confirm as its
  // fail-closed gate.
  const useActuators = options.actuators === true && options.withTools === true;
  if (options.actuators === true && options.withTools !== true) {
    io.stderr("(--actuators has no effect without --with-tools)\n");
  }
  let extraTools: MuseTool[] | undefined;
  // mac_screen_read's vision callback resolves lazily through this holder:
  // the actuator tools are built BEFORE the assembly/model exist, but the
  // tool only ever runs long after both are set (by the caller, once known).
  const screenVision: ScreenVisionHolder = {};
  if (useActuators) {
    const actuatorMod = await import("./actuator-tools.js");
    const actuatorEnv = process.env;
    io.stderr(actuatorMod.formatActuatorBanner(actuatorMod.summarizeActuators(actuatorEnv, io)));
    extraTools = actuatorMod.buildActuatorTools({
      describeScreenImage: async (input) =>
        screenVision.current ? screenVision.current(input) : { error: "the local vision model is not available in this run", ok: false },
      env: actuatorEnv,
      io,
      userId: userKey
    });
  }
  // Browser control (Hermes-style browser_*) is available BY DEFAULT under
  // --with-tools — not gated behind --actuators. Reads/navigation are free;
  // browser_click/type carry the draft-first confirm. Chrome launches lazily
  // on first use, so registering the tools costs nothing.
  let browserControllerToRelease: { disconnect(): Promise<void> } | undefined;
  if (options.withTools === true) {
    const actuatorMod = await import("./actuator-tools.js");
    const browserTools = actuatorMod.buildBrowserTools({
      env: process.env,
      io,
      onController: (controller) => { browserControllerToRelease = controller; },
      // browser_look reads the page visually via the same local vision the
      // screen-read/file-read paths use (lazy holder; model bound below).
      describeImage: async (input) => screenVision.current ? screenVision.current(input) : { error: "the local vision model is not available in this run", ok: false }
    });
    extraTools = extraTools ? [...extraTools, ...browserTools] : browserTools;
    // The @muse/fs read suite rides along by default: file_read (path or
    // name fragment, incl. PDF/Word/image), file_list (glob), file_grep
    // (content search) — read-risk, home-sandboxed, fail-closed on a denied
    // path. The home-wide sandbox supersedes the old 3-folder file_read.
    const { createFsReadTools, createFsWriteTools, defaultCheckpointsDir, FileCheckpointStore, fileReadCharBudget, pathSafetyOptionsFromEnv } = await import("@muse/fs");
    const { createWebDownloadTool } = await import("@muse/domain-tools");
    const { DEFAULT_OLLAMA_NUM_CTX, isWebEgressAllowed } = await import("@muse/model");
    // Sandbox overrides: MUSE_FS_ROOTS narrows the allow-root (default home),
    // MUSE_FS_DENY adds deny prefixes on top of the credential defaults.
    const fsSandbox = pathSafetyOptionsFromEnv(process.env);
    // Opt-in name-fragment search roots. OFF by default: recursively walking
    // the user's Downloads/Desktop/Documents (macOS TCC-protected) on a
    // name-only file_read would fire a system permission prompt unprompted.
    // Set MUSE_FS_DOC_ROOTS to a comma/colon-separated folder list (e.g.
    // "~/Downloads,~/Documents") to re-enable it. Explicit-path reads never
    // need this — they go straight through the home sandbox.
    const fsHome = (await import("node:os")).homedir();
    const fsDocRootsRaw = process.env.MUSE_FS_DOC_ROOTS?.trim();
    const fsDocRoots = fsDocRootsRaw
      ? fsDocRootsRaw
          .split(/[,:]/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
          .map((p) => (p === "~" ? fsHome : p.startsWith("~/") ? `${fsHome}/${p.slice(2)}` : p))
      : [];
    // web_download saves a file from a public URL into ~/Downloads — the
    // write-side companion to file_read (SSRF-guarded, size-capped,
    // basename-only). file_read can then read/summarize what was saved.
    // Read-before-edit grounding: file_edit / file_multi_edit fail-close on a
    // file this run never read (Muse mutates only what it has actually seen).
    const fsReadPaths = new Set<string>();
    // A FULL file_read fills this too; a partial file_grep does NOT — so a
    // whole-file overwrite (file_write) can demand a complete read, not just
    // a grep of a few lines (which would silently drop the rest).
    const fsFullReadPaths = new Set<string>();
    const fsReadTools = createFsReadTools({
      ...fsSandbox,
      ...(fsDocRoots.length > 0 ? { docRoots: fsDocRoots } : {}),
      // Cap a single file_read to fit the local model's context — the 200K
      // default exceeds a 32K-token window whole, so one max read would
      // overflow it and silently drop the prompt/history. The model pages
      // larger files via the returned nextOffset.
      maxTextChars: fileReadCharBudget(DEFAULT_OLLAMA_NUM_CTX),
      // Same context budget for a broad file_grep — 200 matches × 500 chars
      // would otherwise nearly fill the window.
      maxGrepOutputChars: fileReadCharBudget(DEFAULT_OLLAMA_NUM_CTX),
      onPathRead: (canonicalPath) => fsReadPaths.add(canonicalPath),
      onFullRead: (canonicalPath) => fsFullReadPaths.add(canonicalPath),
      // file_read reads an IMAGE file via the same local vision the screen-
      // read path uses (lazy holder — the assembly/model is bound below).
      describeImage: async (input) => screenVision.current ? screenVision.current(input) : { error: "the local vision model is not available in this run", ok: false }
    });
    // file_write / file_edit / file_multi_edit: home-sandboxed + deny-listed
    // and gated by a fail-close confirm (the exposure policy only surfaces
    // them when the prompt shows mutation intent). Every approved write is
    // ALSO checkpointed here — `muse rollback` restores it — so a wrong
    // overwrite is undoable, not just gated.
    const { confirm: fsConfirm, isCancel: fsIsCancel } = await import("@clack/prompts");
    const fsWriteTools = createFsWriteTools({
      ...fsSandbox,
      wasPathRead: (canonicalPath) => fsReadPaths.has(canonicalPath),
      wasPathFullyRead: (canonicalPath) => fsFullReadPaths.has(canonicalPath),
      checkEditIntegrity: true,
      checkpointStore: new FileCheckpointStore({ dir: defaultCheckpointsDir(process.env) }),
      approvalGate: actuatorMod.buildFsWriteApprovalGate({
        confirmAction: (message: string) => fsConfirm({ message }).then((answer) => !fsIsCancel(answer) && answer === true),
        io,
        stagePendingApproval: actuatorMod.buildCliPendingApprovalStager({ file: resolvePendingApprovalsFile(process.env) })
      })
    });
    // web_download reaches the public web, so the master web-egress switch
    // (airplane mode) removes it; fs tools are local and unaffected.
    const webDownloadTools = isWebEgressAllowed(process.env)
      ? [createWebDownloadTool({ fetchImpl: globalThis.fetch })]
      : [];
    extraTools = [...extraTools, ...fsReadTools, ...fsWriteTools, ...webDownloadTools];
  }
  // The agent's `muse.messaging.send` (a default loopback tool whenever a
  // messenger is configured) gets a draft-first confirm gate under --with-tools:
  // show the exact {provider, destination, text} and fire ONLY on confirm,
  // fail-closed in a non-TTY. Without this gate the send fail-closes entirely
  // Built independently of --actuators so a benign "send X" isn't
  // blocked by the actuator tool descriptions' injection-guard false-positive.
  let messagingApprovalGate: MessageApprovalGate | undefined;
  if (options.withTools === true) {
    const actuatorMod = await import("./actuator-tools.js");
    const { confirm, isCancel } = await import("@clack/prompts");
    messagingApprovalGate = actuatorMod.buildMessagingApprovalGate({
      confirmAction: (message: string) => confirm({ message }).then((answer) => !isCancel(answer) && answer === true),
      io
    });
  }

  return { browserControllerToRelease, extraTools, messagingApprovalGate, screenVision, useActuators };
}
