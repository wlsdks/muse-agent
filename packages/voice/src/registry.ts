import { VoiceProviderError } from "./errors.js";
import { resolveTtsPersona } from "./persona.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  TtsPersona,
  TtsRequest,
  TtsResponse
} from "./types.js";

/**
 * Holds the configured voice providers. Voice mode pairs one STT
 * with one TTS, so the registry stays simple — list, register, get
 * primary, lookup by id. No multi-provider fan-out (unlike calendar).
 */
export class VoiceProviderRegistry {
  private readonly stt = new Map<string, SpeechToTextProvider>();
  private readonly tts = new Map<string, TextToSpeechProvider>();

  registerStt(provider: SpeechToTextProvider): void {
    this.stt.set(provider.id, provider);
  }

  registerTts(provider: TextToSpeechProvider): void {
    this.tts.set(provider.id, provider);
  }

  listStt(): readonly SpeechToTextProvider[] {
    return [...this.stt.values()];
  }

  listTts(): readonly TextToSpeechProvider[] {
    return [...this.tts.values()];
  }

  primaryStt(): SpeechToTextProvider | undefined {
    return this.listStt()[0];
  }

  primaryTts(): TextToSpeechProvider | undefined {
    return this.listTts()[0];
  }

  requireStt(id: string): SpeechToTextProvider {
    const provider = this.stt.get(id);
    if (!provider) {
      throw new VoiceProviderError(
        id,
        "STT_NOT_FOUND",
        `STT provider not registered: ${id}${registeredHint([...this.stt.keys()])}`
      );
    }
    return provider;
  }

  requireTts(id: string): TextToSpeechProvider {
    const provider = this.tts.get(id);
    if (!provider) {
      throw new VoiceProviderError(
        id,
        "TTS_NOT_FOUND",
        `TTS provider not registered: ${id}${registeredHint([...this.tts.keys()])}`
      );
    }
    return provider;
  }

  /**
   * Synthesize using a persona's defaults (provider + voice/format/speed)
   * with the request's explicit fields taking precedence. The persona
   * picks the provider; when it names none, the primary TTS provider is
   * used. Keeps "the voice of Muse" consistent without every caller
   * restating provider/voice.
   */
  async synthesizeWithPersona(persona: TtsPersona | undefined, request: TtsRequest): Promise<TtsResponse> {
    const resolved = resolveTtsPersona(persona, request);
    const provider = resolved.providerId !== undefined ? this.requireTts(resolved.providerId) : this.primaryTts();
    if (!provider) {
      throw new VoiceProviderError(
        resolved.providerId ?? "(primary)",
        "TTS_NOT_FOUND",
        `No TTS provider available${registeredHint([...this.tts.keys()])}`
      );
    }
    return provider.synthesize(resolved.request);
  }
}

function registeredHint(ids: readonly string[]): string {
  return ids.length > 0 ? ` (registered: ${ids.join(", ")})` : " (none registered)";
}
