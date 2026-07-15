import { VoiceProviderError, VoiceValidationError } from "./errors.js";
import { safeReadText } from "./http-utils.js";
import type {
  TextToSpeechProvider,
  TtsFormat,
  TtsProviderInfo,
  TtsRequest,
  TtsResponse
} from "./types.js";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const DEFAULT_MODEL = "tts-1";
const DEFAULT_VOICE = "alloy";
const AVAILABLE_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
const SUPPORTED_FORMATS: readonly TtsFormat[] = ["mp3", "wav", "opus", "aac", "flac"] as const;

const FORMAT_MIME: Record<TtsFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac"
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAITtsProviderOptions {
  readonly id?: string;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly defaultVoice?: string;
  readonly defaultFormat?: TtsFormat;
  readonly fetchImpl?: FetchLike;
}

/**
 * OpenAI text-to-speech adapter. POSTs a JSON body to
 * `/v1/audio/speech` and returns the binary audio body. Output format
 * is configurable per-call (mp3 default).
 */
export class OpenAITtsProvider implements TextToSpeechProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly defaultVoice: string;
  private readonly defaultFormat: TtsFormat;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAITtsProviderOptions) {
    if (!options.apiKey) {
      throw new VoiceValidationError("MISSING_API_KEY", "OpenAI TTS requires an API key");
    }
    this.id = options.id ?? "openai-tts";
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.model = options.model ?? DEFAULT_MODEL;
    this.defaultVoice = options.defaultVoice ?? DEFAULT_VOICE;
    this.defaultFormat = options.defaultFormat ?? "mp3";
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    if (!this.fetchImpl) {
      throw new VoiceValidationError("NO_FETCH", "global fetch is unavailable; pass fetchImpl");
    }
  }

  describe(): TtsProviderInfo {
    return {
      id: this.id,
      displayName: "OpenAI TTS",
      description: "Cloud TTS via api.openai.com /v1/audio/speech",
      local: false,
      availableVoices: AVAILABLE_VOICES,
      supportedFormats: SUPPORTED_FORMATS
    };
  }

  async synthesize(request: TtsRequest): Promise<TtsResponse> {
    if (!request.text || request.text.trim().length === 0) {
      throw new VoiceValidationError("EMPTY_TEXT", "synthesize() requires non-empty text");
    }

    const format = request.format ?? this.defaultFormat;
    if (!SUPPORTED_FORMATS.includes(format)) {
      throw new VoiceValidationError("UNSUPPORTED_FORMAT", `Unsupported TTS format: ${format}`);
    }

    const body = {
      model: this.model,
      input: request.text,
      voice: request.voice ?? this.defaultVoice,
      response_format: format,
      speed: request.speed
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      throw new VoiceProviderError(this.id, "FETCH_FAILED", "TTS request failed", cause);
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new VoiceProviderError(
        this.id,
        `HTTP_${response.status}`,
        `OpenAI TTS failed: ${detail.slice(0, 200)}`
      );
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (cause) {
      throw new VoiceProviderError(this.id, "BAD_BODY", "TTS response body unreadable", cause);
    }

    const audio = new Uint8Array(buffer);
    if (audio.byteLength === 0) {
      throw new VoiceProviderError(this.id, "EMPTY_BODY", "TTS returned empty audio");
    }

    return {
      audio,
      mimeType: FORMAT_MIME[format],
      format
    };
  }
}
