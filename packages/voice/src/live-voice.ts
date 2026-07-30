/**
 * Live (duplex) voice provider abstraction — Voice Phase F.3 of
 * `docs/design/channels/voice-mode.md`.
 *
 * Gemini Live and OpenAI Realtime both stream audio + text over a
 * single websocket: the client pushes audio frames as the user
 * speaks, and the server fans back text deltas + audio chunks +
 * "turn complete" markers in parallel. The one-shot
 * `SpeechToTextProvider.transcribe()` + `TextToSpeechProvider.synthesize()`
 * contracts don't model that — they're request-response.
 *
 * This module ships the abstraction (`LiveVoiceProvider`,
 * `LiveVoiceSession`, `LiveVoiceEvent`) plus a `FakeLiveVoiceProvider`
 * for tests / dry runs. The actual GeminiLiveProvider /
 * OpenAIRealtimeProvider implementations ship in follow-up iters
 * once dogfood signals justify the websocket-reconnect work.
 */

export interface LiveVoiceProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
}

export interface LiveVoiceOpenOptions {
  /** Provider-specific voice id (Gemini: "Charon", OpenAI Realtime: "alloy"). */
  readonly voice?: string;
  /** Optional system prompt prepended to the session. */
  readonly system?: string;
  /** Mime type of the audio chunks the caller will send. */
  readonly inputMimeType?: string;
}

export type LiveVoiceEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "audio-delta"; readonly audio: Uint8Array; readonly mimeType: string }
  | { readonly type: "turn-complete" }
  | { readonly type: "error"; readonly error: Error };

export interface LiveVoiceSession {
  /**
   * Push an audio chunk into the live session. Implementations
   * should be tolerant of empty / zero-length buffers (treat as
   * no-op) — sox / mic loops sometimes emit them at startup.
   */
  sendAudio(chunk: Uint8Array): Promise<void>;
  /**
   * Signal the end of the user's current utterance, prompting the
   * provider to start its turn. Some providers auto-detect via
   * silence; calling `endTurn()` explicitly forces the boundary.
   */
  endTurn(): Promise<void>;
  /**
   * AsyncIterable of model-side events. Iterates until `close()` is
   * called or the underlying transport closes. Implementations
   * surface websocket-level errors as `{ type: "error", error }`
   * events rather than throwing through the iterator, so a single
   * loop can handle text + audio + errors uniformly.
   */
  events(): AsyncIterable<LiveVoiceEvent>;
  /** Close the session. Idempotent — safe to call multiple times. */
  close(): Promise<void>;
}

export interface LiveVoiceProvider {
  readonly id: string;
  describe(): LiveVoiceProviderInfo;
  open(options?: LiveVoiceOpenOptions): Promise<LiveVoiceSession>;
}

/**
 * In-memory FakeLiveVoiceProvider — the test seam. Captures every
 * sendAudio / endTurn call and emits a scripted sequence of
 * LiveVoiceEvents back through `events()`. Useful for asserting
 * that a `muse listen --live` CLI loop pumps audio in and reads
 * deltas out without needing a real provider key.
 */
export interface FakeLiveVoiceProviderOptions {
  readonly id?: string;
  /** Events to emit through every session opened from this provider. */
  readonly script: readonly LiveVoiceEvent[];
}

export class FakeLiveVoiceProvider implements LiveVoiceProvider {
  readonly id: string;
  /** Spawned sessions (test reads .audioChunks / .endTurns to assert). */
  readonly sessions: FakeLiveVoiceSession[] = [];
  private readonly script: readonly LiveVoiceEvent[];

  constructor(options: FakeLiveVoiceProviderOptions) {
    this.id = options.id ?? "fake-live-voice";
    this.script = options.script;
  }

  describe(): LiveVoiceProviderInfo {
    return {
      id: this.id,
      displayName: "Fake Live Voice",
      description: "In-memory duplex provider for tests / dry runs",
      local: true
    };
  }

  async open(): Promise<LiveVoiceSession> {
    const session = new FakeLiveVoiceSession(this.script);
    this.sessions.push(session);
    return session;
  }
}

export class FakeLiveVoiceSession implements LiveVoiceSession {
  readonly audioChunks: Uint8Array[] = [];
  endTurns = 0;
  closed = false;
  private readonly script: readonly LiveVoiceEvent[];

  constructor(script: readonly LiveVoiceEvent[]) {
    this.script = script;
  }

  async sendAudio(chunk: Uint8Array): Promise<void> {
    if (this.closed) {
      throw new Error("FakeLiveVoiceSession: sendAudio after close");
    }
    if (chunk.byteLength === 0) return;
    this.audioChunks.push(chunk);
  }

  async endTurn(): Promise<void> {
    if (this.closed) {
      throw new Error("FakeLiveVoiceSession: endTurn after close");
    }
    this.endTurns += 1;
  }

  events(): AsyncIterable<LiveVoiceEvent> {
    // Each call to events() replays the script from the top. The
    // session is async-iterable; consumers `for await` the result.
    const script = this.script;
    const closedRef = () => this.closed;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<LiveVoiceEvent> {
        for (const event of script) {
          if (closedRef()) return;
          yield event;
        }
      }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
