import { useCallback, useRef, useState } from "react";

import { isRecord, parseJson, readOptionalString } from "./safe-json.js";

interface SttResponse {
  readonly text?: string;
}

/**
 * Browser voice I/O against the API's `/api/voice/*` routes.
 * `toggleRecording` push-to-talks: first call opens the mic and records,
 * the second stops, base64-encodes the clip, POSTs it to `/api/voice/stt`,
 * and resolves the transcript via `onTranscript`. `speak` synthesizes a
 * reply through `/api/voice/tts` and plays it. Both fail soft — a missing
 * provider (503) or denied mic surfaces in `error`, never throws.
 */
export function useVoice(baseUrl: string, token: string) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const authHeaders = useCallback(
    (extra?: Record<string, string>) => ({
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra
    }),
    [token]
  );

  const toggleRecording = useCallback(
    async (onTranscript: (text: string) => void) => {
      setError(null);

      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError("Microphone access was denied.");
        return;
      }

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        setRecording(false);
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) {
          return;
        }
        setTranscribing(true);
        try {
          const audioBase64 = await blobToBase64(blob);
          const res = await fetch(new URL("/api/voice/stt", baseUrl).toString(), {
            body: JSON.stringify({ audioBase64, mimeType: blob.type }),
            headers: authHeaders({ "content-type": "application/json" }),
            method: "POST"
          });
          if (!res.ok) {
            throw new Error(res.status === 503 ? "No speech-to-text provider is configured." : `STT failed (${res.status})`);
          }
          const parsed = parseSttResponse(parseJson(await res.text()));
          if (parsed?.text?.trim()) {
            onTranscript(parsed.text.trim());
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Transcription failed.");
        } finally {
          setTranscribing(false);
        }
      };

      recorder.start();
      setRecording(true);
    },
    [authHeaders, baseUrl]
  );

  const speak = useCallback(
    async (text: string) => {
      setError(null);
      if (!text.trim()) {
        return;
      }
      try {
        audioRef.current?.pause();
        const res = await fetch(new URL("/api/voice/tts", baseUrl).toString(), {
          body: JSON.stringify({ text }),
          headers: authHeaders({ "content-type": "application/json" }),
          method: "POST"
        });
        if (!res.ok) {
          throw new Error(res.status === 503 ? "No text-to-speech provider is configured." : `TTS failed (${res.status})`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          setSpeaking(false);
          URL.revokeObjectURL(url);
        };
        setSpeaking(true);
        await audio.play();
      } catch (cause) {
        setSpeaking(false);
        setError(cause instanceof Error ? cause.message : "Playback failed.");
      }
    },
    [authHeaders, baseUrl]
  );

  return { error, recording, speak, speaking, toggleRecording, transcribing };
}

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  });
}

function parseSttResponse(value: unknown): SttResponse | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text = readOptionalString(value.text);
  return { text };
}
