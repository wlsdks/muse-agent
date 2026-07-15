import { VoiceProviderError } from "./errors.js";
import { resolveTtsPersona } from "./persona.js";
import { truncateForTts } from "./tts-truncate.js";
import { errorMessage } from "@muse/shared";

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
    return provider.synthesize({ ...resolved.request, text: truncateForTts(resolved.request.text) });
  }

  /**
   * Synthesize with a provider FALLBACK chain: try each TTS provider in
   * order (the given ids, else every registered provider in registration
   * order) and return the FIRST success. When one fails (binary missing,
   * transient error), move to the next instead of failing the whole call
   * — a local-first resilience win when several TTS backends are
   * installed. Throws only when every provider failed or none is
   * registered, naming each attempt's failure.
   */
  async synthesizeWithFallback(request: TtsRequest, providerIds?: readonly string[]): Promise<TtsResponse> {
    const ids = providerIds && providerIds.length > 0 ? providerIds : [...this.tts.keys()];
    if (ids.length === 0) {
      throw new VoiceProviderError(
        "(fallback)",
        "TTS_NOT_FOUND",
        `No TTS provider available${registeredHint([...this.tts.keys()])}`
      );
    }
    const failures: string[] = [];
    for (const id of ids) {
      const provider = this.tts.get(id);
      if (!provider) {
        failures.push(`${id}: not registered`);
        continue;
      }
      try {
        return await provider.synthesize({ ...request, text: truncateForTts(request.text) });
      } catch (error) {
        failures.push(`${id}: ${errorMessage(error)}`);
      }
    }
    throw new VoiceProviderError(
      ids[0] ?? "(fallback)",
      "TTS_SYNTHESIS_FAILED",
      `All TTS providers failed: ${failures.join("; ")}`
    );
  }
}

function registeredHint(ids: readonly string[]): string {
  return ids.length > 0 ? ` (registered: ${ids.join(", ")})` : " (none registered)";
}
