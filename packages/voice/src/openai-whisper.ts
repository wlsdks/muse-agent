import { VoiceProviderError, VoiceValidationError } from "./errors.js";
import { safeReadText } from "./http-utils.js";
import { createStringSetGuard, isRecord } from "@muse/shared";
import type {
  SpeechToTextProvider,
  SttProviderInfo,
  SttRequest,
  SttResponse
} from "./types.js";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-1";
const SUPPORTED_FORMATS = [
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/flac"
] as const;
const isSupportedFormat = createStringSetGuard(SUPPORTED_FORMATS);

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAIWhisperSttProviderOptions {
  readonly id?: string;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * OpenAI Whisper API adapter. Posts a `multipart/form-data` request
 * with the audio blob and parses the JSON response. Built against the
 * `/v1/audio/transcriptions` shape — `verbose_json` would give us
 * timestamps but we ship plain `json` for v1.
 */
export class OpenAIWhisperSttProvider implements SpeechToTextProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAIWhisperSttProviderOptions) {
    if (!options.apiKey) {
      throw new VoiceValidationError("MISSING_API_KEY", "OpenAI Whisper STT requires an API key");
    }
    this.id = options.id ?? "openai-whisper";
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.model = options.model ?? DEFAULT_MODEL;
    const defaultFetch = globalThis.fetch;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    if (typeof this.fetchImpl !== "function") {
      throw new VoiceValidationError("NO_FETCH", "global fetch is unavailable; pass fetchImpl");
    }
  }

  describe(): SttProviderInfo {
    return {
      id: this.id,
      displayName: "OpenAI Whisper",
      description: "Cloud STT via api.openai.com /v1/audio/transcriptions",
      local: false,
      supportedFormats: SUPPORTED_FORMATS
    };
  }

  async transcribe(request: SttRequest): Promise<SttResponse> {
    if (!request.audio || request.audio.byteLength === 0) {
      throw new VoiceValidationError("EMPTY_AUDIO", "transcribe() requires non-empty audio bytes");
    }
    if (!request.mimeType) {
      throw new VoiceValidationError("MISSING_MIME_TYPE", "transcribe() requires mimeType");
    }
    // Enforce the advertised `describe().supportedFormats` rather
    // than POSTing an unknown container and getting a cryptic API
    // 400 back. Strip any `; codecs=…` parameter before matching.
    // Same gate the local Whisper.cpp adapter applies.
    const baseMime = request.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!isSupportedFormat(baseMime)) {
      throw new VoiceValidationError(
        "UNSUPPORTED_FORMAT",
        `unsupported audio format "${request.mimeType}"; supported: ${SUPPORTED_FORMATS.join(", ")}`
      );
    }

    const form = new FormData();
    const blob = new Blob([new Uint8Array(request.audio)], { type: request.mimeType });
    form.append("file", blob, this.fileNameFor(request.mimeType));
    form.append("model", this.model);
    form.append("response_format", "json");
    if (request.language) {
      form.append("language", request.language);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form
      });
    } catch (cause) {
      throw new VoiceProviderError(this.id, "FETCH_FAILED", "Whisper request failed", cause);
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new VoiceProviderError(
        this.id,
        `HTTP_${response.status}`,
        `Whisper transcription failed: ${detail.slice(0, 200)}`
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new VoiceProviderError(this.id, "BAD_JSON", "Whisper returned invalid JSON", cause);
    }

    if (!isRecord(body) || typeof body.text !== "string") {
      throw new VoiceProviderError(
        this.id,
        "BAD_SHAPE",
        "Whisper response missing `text` field"
      );
    }

    const text = body.text;
    const language = typeof body.language === "string" ? body.language : undefined;
    const durationSec = typeof body.duration === "number" ? body.duration : undefined;
    return {
      text,
      language: typeof language === "string" ? language : undefined,
      durationMs: typeof durationSec === "number" ? Math.round(durationSec * 1000) : undefined,
      raw: body
    };
  }

  private fileNameFor(mime: string): string {
    if (mime.includes("wav")) return "audio.wav";
    if (mime.includes("mpeg") || mime.includes("mp3")) return "audio.mp3";
    if (mime.includes("mp4")) return "audio.mp4";
    if (mime.includes("webm")) return "audio.webm";
    if (mime.includes("ogg")) return "audio.ogg";
    if (mime.includes("flac")) return "audio.flac";
    return "audio.bin";
  }
}
