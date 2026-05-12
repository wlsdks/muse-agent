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
  private readonly needle: string;

  constructor(options: TextScanWakeWordDetectorOptions) {
    const phrase = options.phrase.trim();
    if (phrase.length === 0) {
      throw new Error("TextScanWakeWordDetector phrase must be non-empty");
    }
    this.id = options.id ?? "text-scan";
    this.phrase = phrase;
    this.needle = normalise(phrase);
  }

  describe(): WakeWordDetectorInfo {
    return {
      id: this.id,
      displayName: "Text-scan wake word",
      description: `Substring match on the transcript for "${this.phrase}" (case-insensitive)`
    };
  }

  scan(text: string): WakeWordDetectorResult {
    if (!text) {
      return { detected: false };
    }
    const haystack = normalise(text);
    const matchIndex = haystack.indexOf(this.needle);
    if (matchIndex < 0) {
      return { detected: false };
    }
    // Find the same offset in the original text by re-normalising
    // prefixes until lengths match. This is O(text length) but the
    // transcripts we scan are short (single utterance).
    const tailOriginal = sliceAfterPhraseInOriginal(text, this.needle);
    return tailOriginal.length > 0
      ? { detected: true, residual: tailOriginal }
      : { detected: true };
  }
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ") // strip punctuation / symbols
    .replace(/\s+/g, " ")
    .trim();
}

function sliceAfterPhraseInOriginal(original: string, needle: string): string {
  // Walk the original text character-by-character, tracking the
  // normalised cursor. When the cursor passes the end of the
  // (needle's first match in the normalised string), return the
  // original-text tail from that position. Defensive — if normalisation
  // collapses runs, the cursor might land inside whitespace; trim the
  // tail.
  let normalisedSoFar = "";
  for (let i = 0; i < original.length; i += 1) {
    normalisedSoFar = normalise(original.slice(0, i + 1));
    const matchIndex = normalisedSoFar.indexOf(needle);
    if (matchIndex >= 0 && matchIndex + needle.length === normalisedSoFar.length) {
      return original.slice(i + 1).trim();
    }
  }
  return "";
}
