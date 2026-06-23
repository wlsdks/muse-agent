/**
 * Deterministic TTS persona resolution.
 *
 * A persona carries default voice settings (provider + voice / format /
 * speed) so callers reuse one consistent "voice of Muse" instead of
 * restating provider/voice on every call. Precedence is fixed and
 * obvious: a per-call TtsRequest field ALWAYS wins over the persona's;
 * the persona only fills the gaps. Pure — no I/O, no provider lookup.
 */

import type { TtsPersona, TtsRequest } from "./types.js";

export interface ResolvedTtsPersona {
  /** Provider to dispatch to (from the persona), or undefined to use the registry default. */
  readonly providerId?: string;
  /** The request with persona defaults filled in under any explicit request fields. */
  readonly request: TtsRequest;
}

export function resolveTtsPersona(persona: TtsPersona | undefined, request: TtsRequest): ResolvedTtsPersona {
  const voice = request.voice ?? persona?.voice;
  const format = request.format ?? persona?.format;
  const speed = request.speed ?? persona?.speed;
  return {
    ...(persona?.providerId !== undefined ? { providerId: persona.providerId } : {}),
    request: {
      text: request.text,
      ...(voice !== undefined ? { voice } : {}),
      ...(format !== undefined ? { format } : {}),
      ...(speed !== undefined ? { speed } : {})
    }
  };
}
