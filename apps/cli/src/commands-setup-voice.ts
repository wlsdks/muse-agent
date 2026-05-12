/**
 * `muse setup voice` — probe the local voice toolchain.
 *
 * Companion to `muse setup local`: same probe-and-report UX, but for
 * the F.2 / F.3 voice loop. The CLI checks whether `whisper-cpp` (STT)
 * and `piper` (TTS) plus their model files are present, then prints
 * exactly what to install / download to fill the gaps.
 *
 * Strictly diagnostic — does not download model weights or run brew
 * install on the user's behalf. Voice models are several hundred MB
 * each and the user picks the language; an auto-download would be a
 * blast-radius surprise.
 */

import { access, constants, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface ProbeResult {
  readonly label: string;
  readonly status: "ok" | "todo";
  readonly detail: string;
  readonly fix?: string;
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandOnPath(name: string): Promise<string | undefined> {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = pathJoin(dir, name);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function findFirstOnnx(dir: string): Promise<string | undefined> {
  try {
    const entries = await readdir(dir);
    return entries.find((entry) => entry.endsWith(".onnx"));
  } catch {
    return undefined;
  }
}

async function probeWhisperBinary(): Promise<ProbeResult> {
  const explicit = process.env.MUSE_WHISPER_CPP_PATH?.trim();
  if (explicit && explicit.length > 0) {
    const present = await fileExists(explicit);
    return present
      ? { detail: `MUSE_WHISPER_CPP_PATH=${explicit}`, label: "whisper-cpp binary", status: "ok" }
      : {
        detail: `MUSE_WHISPER_CPP_PATH=${explicit} not found`,
        fix: "Fix the env path or unset MUSE_WHISPER_CPP_PATH",
        label: "whisper-cpp binary",
        status: "todo"
      };
  }
  const found = await commandOnPath("whisper-cpp") ?? await commandOnPath("whisper-cli");
  if (found) {
    return { detail: found, label: "whisper-cpp binary", status: "ok" };
  }
  return {
    detail: "not on PATH",
    fix: "macOS: brew install whisper-cpp   |   Linux: build from github.com/ggerganov/whisper.cpp",
    label: "whisper-cpp binary",
    status: "todo"
  };
}

async function probeWhisperModel(): Promise<ProbeResult> {
  const defaultPath = pathJoin(homedir(), ".muse", "whisper-models", "ggml-base.en.bin");
  if (await fileExists(defaultPath)) {
    return { detail: defaultPath, label: "whisper ggml model", status: "ok" };
  }
  return {
    detail: `${defaultPath} not found`,
    fix:
      "mkdir -p ~/.muse/whisper-models && curl -L -o ~/.muse/whisper-models/ggml-base.en.bin " +
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    label: "whisper ggml model",
    status: "todo"
  };
}

async function probePiperBinary(): Promise<ProbeResult> {
  const found = await commandOnPath("piper");
  if (found) {
    return { detail: found, label: "piper binary", status: "ok" };
  }
  return {
    detail: "not on PATH",
    fix:
      "pipx install piper-tts        # any OS\n" +
      "       or download a release from github.com/rhasspy/piper/releases",
    label: "piper binary",
    status: "todo"
  };
}

async function probePiperVoice(): Promise<ProbeResult> {
  const voicesDir = pathJoin(homedir(), ".muse", "piper-voices");
  const onnx = await findFirstOnnx(voicesDir);
  if (onnx) {
    return { detail: pathJoin(voicesDir, onnx), label: "piper voice (.onnx)", status: "ok" };
  }
  return {
    detail: `${voicesDir}/*.onnx not found`,
    fix:
      "mkdir -p ~/.muse/piper-voices && cd ~/.muse/piper-voices && " +
      "curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx " +
      "&& curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
    label: "piper voice (.onnx)",
    status: "todo"
  };
}

async function probeSox(): Promise<ProbeResult> {
  const sox = await commandOnPath("sox") ?? await commandOnPath("rec");
  if (sox) {
    return { detail: sox, label: "sox (mic capture for `muse listen`)", status: "ok" };
  }
  return {
    detail: "not on PATH",
    fix:
      "macOS: brew install sox        # records WAV from the system mic\n" +
      "       Linux: apt install sox  # or `pip install sounddevice` for a Python alt",
    label: "sox (mic capture for `muse listen`)",
    status: "todo"
  };
}

function renderResult(result: ProbeResult): string {
  const tag = result.status === "ok" ? "[ok]  " : "[todo]";
  const lines: string[] = [`  ${tag} ${result.label} — ${result.detail}`];
  if (result.status === "todo" && result.fix) {
    for (const line of result.fix.split("\n")) {
      lines.push(`         → ${line.trim()}`);
    }
  }
  return lines.join("\n");
}

export function registerSetupVoiceCommand(program: Command, io: ProgramIO): void {
  const setupRoot = program.commands.find((cmd) => cmd.name() === "setup");
  if (!setupRoot) {
    throw new Error("registerSetupVoiceCommand: 'setup' command group must be registered first.");
  }
  setupRoot
    .command("voice")
    .description("Probe the local voice toolchain (whisper.cpp STT + piper TTS) and report install gaps")
    .option("--json", "Emit machine-readable JSON instead of the formatted report")
    .action(async (options: { readonly json?: boolean }) => {
      const results = await Promise.all([
        probeWhisperBinary(),
        probeWhisperModel(),
        probePiperBinary(),
        probePiperVoice(),
        probeSox()
      ]);

      if (options.json) {
        io.stdout(`${JSON.stringify({ ok: results.every((r) => r.status === "ok"), probes: results }, null, 2)}\n`);
        return;
      }

      io.stdout("Muse voice toolchain:\n");
      for (const result of results) {
        io.stdout(`${renderResult(result)}\n`);
      }
      const todoCount = results.filter((r) => r.status === "todo").length;
      io.stdout("\n");
      if (todoCount === 0) {
        io.stdout(`All ${results.length.toString()} checks green — \`muse listen\` and \`/api/voice/tts\` should work end-to-end.\n`);
      } else {
        io.stdout(`${todoCount.toString()} of ${results.length.toString()} steps still missing. Follow the → hints above.\n`);
        io.stdout("Full docs: docs/setup-local-llm.md → \"Voice mode\" (when added) or docs/design/voice-mode.md.\n");
      }
    });
}
