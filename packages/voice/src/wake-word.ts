/**
 * Wake-word detector abstraction (Voice Phase F.1 of
 * `docs/design/voice-mode.md`). Provider-neutral so a future ONNX
 * adapter (openWakeWord / Porcupine) slots in without changing the
 * `muse listen --wake` loop.
 *
 * The first implementation, `TextScanWakeWordDetector`, runs on
 * **transcribed text** rather than raw audio frames. The
 * `muse listen --wake` loop records short rolling clips, transcribes
 * each through the configured `SpeechToTextProvider`, and asks the
 * detector whether the transcript contains the wake phrase. This
 * trades CPU efficiency (we keep paying for STT every clip) for
 * zero extra dependencies — no ONNX runtime, no model file download,
 * no audio-frame DSP pipeline. The ONNX adapter ships when the
 * dogfood data justifies the integration cost.
 */

export interface WakeWordDetectorInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}

export interface WakeWordDetectorResult {
  readonly detected: boolean;
  /**
   * Text after the wake phrase, trimmed. When the user says
   * "Hey Muse what's the weather?" the residual is
   * "what's the weather?" and the loop can use it directly without
   * recording another clip. `undefined` when the phrase is at the
   * tail of the input (no follow-up captured this clip).
   */
  readonly residual?: string;
}

export interface WakeWordDetector {
  readonly id: string;
  describe(): WakeWordDetectorInfo;
  /**
   * Scan a transcript for the wake phrase. Pure synchronous —
   * detectors may not perform I/O. Audio-based detectors (future)
   * will expose a separate `feedAudioFrame()` API instead of this
   * one; the loop will branch on `kind`.
   */
  scan(text: string): WakeWordDetectorResult;
}

export interface TextScanWakeWordDetectorOptions {
  /**
   * Phrase to match, case-insensitive after normalisation. Spaces
   * are collapsed so "hey  muse" (double space) still matches
   * "hey muse". Punctuation around the phrase is tolerated.
   */
  readonly phrase: string;
  /**
   * Goal 121 — additional phrases that should also wake the
   * loop. Lets a user say "Hey Muse" OR "OK Muse" OR a bare
   * "Muse" without composing multiple detectors. Each alias is
   * normalised the same way as `phrase`; empty / whitespace-only
   * entries are dropped silently. First match wins, so callers
   * should list the most-specific phrases first (a bare "Muse"
   * before "Hey Muse" would steal the prompt residual).
   */
  readonly aliases?: readonly string[];
  readonly id?: string;
}

/**
 * Case-insensitive substring detector. Matches the wake phrase in
 * any position of the transcript and returns whatever follows it as
 * the residual. The first match wins (a user who says "hey muse hey
 * muse what's up" gets "hey muse what's up" as the prompt — which is
 * the right behaviour for a stuttered wake).
 */
export class TextScanWakeWordDetector implements WakeWordDetector {
  readonly id: string;
  private readonly phrase: string;
  /**
   * Goal 121 — needles ordered by caller intent so the first
   * match wins. `phrase` is always at index 0; aliases follow in
   * the order the caller supplied. Whitespace-only aliases drop
   * out so the empty case doesn't degrade to a substring-of-
   * everything `""` match.
   */
  private readonly needles: readonly string[];
  private readonly phrasesDisplay: readonly string[];

  constructor(options: TextScanWakeWordDetectorOptions) {
    const phrase = options.phrase.trim();
    if (phrase.length === 0) {
      throw new Error("TextScanWakeWordDetector phrase must be non-empty");
    }
    this.id = options.id ?? "text-scan";
    this.phrase = phrase;
    const cleanAliases = (options.aliases ?? [])
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    this.phrasesDisplay = [phrase, ...cleanAliases];
    // Dedup needles after normalisation so callers can pass an
    // alias that collapses to the same string as `phrase` without
    // surprising the matcher.
    const seen = new Set<string>();
    const needles: string[] = [];
    for (const candidate of this.phrasesDisplay) {
      const n = normalise(candidate);
      if (n.length === 0 || seen.has(n)) continue;
      seen.add(n);
      needles.push(n);
    }
    this.needles = needles;
  }

  describe(): WakeWordDetectorInfo {
    const quoted = this.phrasesDisplay.map((p) => `"${p}"`).join(" / ");
    return {
      id: this.id,
      displayName: "Text-scan wake word",
      description: `Substring match on the transcript for ${quoted} (case-insensitive)`
    };
  }

  scan(text: string): WakeWordDetectorResult {
    if (!text) {
      return { detected: false };
    }
    for (const needle of this.needles) {
      const match = findWholePhrase(text, needle);
      if (!match.matched) continue;
      return match.residual.length > 0
        ? { detected: true, residual: match.residual }
        : { detected: true };
    }
    return { detected: false };
  }
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ") // strip punctuation / symbols
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Audio-frame wake-word detector — the future path for
 * onnxruntime-node / openWakeWord / Picovoice Porcupine adapters.
 *
 * Where `WakeWordDetector.scan(text)` runs on already-transcribed
 * text (cheap to wire, expensive to run because every clip pays for
 * STT), this interface consumes raw PCM16 audio frames at a fixed
 * sample rate. The CLI's `muse listen --wake` loop chooses between
 * the two flavours based on configuration:
 *
 *   - Text-scan: chunk-based — record N seconds, STT, scan transcript.
 *   - Audio-frame: stream-based — feed continuous 80 ms PCM16 frames,
 *     poll for the detector's "fired" signal, then capture the next
 *     utterance for the actual prompt.
 *
 * No concrete `OnnxWakeWordDetector` yet — that needs the
 * onnxruntime-node dep + a mel-spectrogram preprocessor + the
 * openWakeWord ONNX model files, all of which want real dogfood
 * before locking the details. The interface + `FakeAudioFrameWakeWordDetector`
 * is enough scaffolding to wire the CLI loop and write tests now.
 */

export interface AudioFrameWakeWordDetectorInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Sample rate the detector expects (Hz). openWakeWord defaults to 16_000. */
  readonly sampleRate: number;
  /** Expected PCM16 frame length in samples (80 ms at 16 kHz = 1280). */
  readonly frameSamples: number;
}

export interface AudioFrameWakeWordDetectorResult {
  readonly detected: boolean;
  /** Model confidence in [0, 1]. Optional — some detectors only return a boolean. */
  readonly confidence?: number;
}

export interface AudioFrameWakeWordDetector {
  readonly id: string;
  describe(): AudioFrameWakeWordDetectorInfo;
  /**
   * Feed a single PCM16 frame. The detector accumulates state across
   * frames; callers don't need to track sliding-window context.
   * Returns the post-frame detection result.
   */
  feedFrame(samples: Int16Array): AudioFrameWakeWordDetectorResult;
  /**
   * Clear internal state — call after a successful wake fire so the
   * next utterance starts fresh and the same model output doesn't
   * re-trigger on tail audio.
   */
  reset(): void;
}

/**
 * Test seam — scripted detector that fires on the Nth feedFrame
 * call. Useful for asserting that the CLI's stream loop reads
 * frames, polls for detection, captures the next utterance, and
 * resets between firings.
 */
export interface FakeAudioFrameWakeWordDetectorOptions {
  readonly id?: string;
  /** Fire on the Nth feedFrame call (1-indexed). Default 1 = fires immediately. */
  readonly fireOnFrame?: number;
  /** Confidence to report on the firing frame. Default 0.95. */
  readonly fireConfidence?: number;
  /** Sample rate to advertise. Default 16_000. */
  readonly sampleRate?: number;
  /** Frame samples to advertise. Default 1280 (80 ms at 16 kHz). */
  readonly frameSamples?: number;
}

export class FakeAudioFrameWakeWordDetector implements AudioFrameWakeWordDetector {
  readonly id: string;
  private readonly fireOnFrame: number;
  private readonly fireConfidence: number;
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private frameCount = 0;

  constructor(options: FakeAudioFrameWakeWordDetectorOptions = {}) {
    this.id = options.id ?? "fake-audio-wake";
    this.fireOnFrame = Math.max(1, options.fireOnFrame ?? 1);
    this.fireConfidence = options.fireConfidence ?? 0.95;
    this.sampleRate = options.sampleRate ?? 16_000;
    this.frameSamples = options.frameSamples ?? 1_280;
  }

  describe(): AudioFrameWakeWordDetectorInfo {
    return {
      id: this.id,
      displayName: "Fake audio-frame wake",
      description: `Scripted detector that fires on frame ${this.fireOnFrame.toString()}`,
      sampleRate: this.sampleRate,
      frameSamples: this.frameSamples
    };
  }

  feedFrame(_samples: Int16Array): AudioFrameWakeWordDetectorResult {
    this.frameCount += 1;
    if (this.frameCount === this.fireOnFrame) {
      return { detected: true, confidence: this.fireConfidence };
    }
    return { detected: false };
  }

  reset(): void {
    this.frameCount = 0;
  }
}

/**
 * First WHOLE-phrase occurrence of `needle` (a normalised,
 * space-delimited token sequence) in `original`, with the trimmed
 * text after it. Whole-phrase, not substring, so a short wake word
 * like "muse" never fires on "museum" / "amusement" / "bemused":
 * the left edge is the string start or a separator (collapsed to a
 * space by `normalise`), and the right edge must end the string or
 * be a separator — not a letter that continues the word.
 */
function findWholePhrase(original: string, needle: string): { matched: boolean; residual: string } {
  for (let i = 0; i < original.length; i += 1) {
    const normalisedSoFar = normalise(original.slice(0, i + 1));
    if (normalisedSoFar !== needle && !normalisedSoFar.endsWith(` ${needle}`)) {
      continue;
    }
    const next = original[i + 1];
    if (next !== undefined && !/[\p{P}\p{S}\s]/u.test(next)) {
      continue;
    }
    // Drop the separator run between the wake phrase and the prompt
    // ("Hey Muse, what's…" → "what's…"). Same boundary class the
    // post-phrase check above uses, so a pause comma / dash isn't
    // fed into the LLM as a leading-punctuation prompt.
    const residual = original.slice(i + 1).replace(/^[\p{P}\p{S}\s]+/u, "").trim();
    return { matched: true, residual };
  }
  return { matched: false, residual: "" };
}
