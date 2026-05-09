import { VoiceProviderError } from "./errors.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider
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
      throw new VoiceProviderError(id, "STT_NOT_FOUND", `STT provider not registered: ${id}`);
    }
    return provider;
  }

  requireTts(id: string): TextToSpeechProvider {
    const provider = this.tts.get(id);
    if (!provider) {
      throw new VoiceProviderError(id, "TTS_NOT_FOUND", `TTS provider not registered: ${id}`);
    }
    return provider;
  }
}
