import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 16000;
const DEFAULT_WHISPERLIVE_WS_URL = "ws://127.0.0.1:9090";
const STARTUP_CANCELLED = Symbol("voice-input-startup-cancelled");

type VoiceInputStatus = "idle" | "connecting" | "listening" | "error";

interface UseComposerVoiceInputOptions {
  readonly disabled: boolean;
  readonly language?: string;
  readonly model?: string;
  readonly whisperLiveWsUrl?: string;
  readonly getPrompt: () => string;
  readonly onPromptChange: (prompt: string) => void;
}

interface VoiceInputSession {
  readonly uid: string;
  basePrompt: string;
  readonly stream: MediaStream;
  readonly audioContext: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly worklet: AudioWorkletNode;
  readonly socket: WebSocket;
  active: boolean;
  committedTranscript: string;
  liveSegments: VoiceSegment[];
  segmentBaselineEnd: number;
  lastTranscript: string;
}

interface WhisperLiveSegment {
  readonly text?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
}

interface VoiceSegment {
  readonly key: string;
  readonly text: string;
  readonly endSeconds: number | null;
}

interface WhisperLiveMessage {
  readonly uid?: unknown;
  readonly message?: unknown;
  readonly segments?: unknown;
}

interface VoiceCaptureWorkletMessage {
  readonly samples?: unknown;
  readonly sampleRate?: unknown;
}

export function useComposerVoiceInput({
  disabled,
  language = "",
  model = "base",
  whisperLiveWsUrl = "",
  getPrompt,
  onPromptChange,
}: UseComposerVoiceInputOptions) {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const sessionRef = useRef<VoiceInputSession | null>(null);
  const startupGenerationRef = useRef(0);
  const isStartingRef = useRef(false);
  const disabledRef = useRef(disabled);
  const whisperLiveWsUrlRef = useRef(whisperLiveWsUrl);
  const getPromptRef = useRef(getPrompt);
  const onPromptChangeRef = useRef(onPromptChange);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    whisperLiveWsUrlRef.current = whisperLiveWsUrl;
  }, [whisperLiveWsUrl]);

  useEffect(() => {
    getPromptRef.current = getPrompt;
  }, [getPrompt]);

  useEffect(() => {
    onPromptChangeRef.current = onPromptChange;
  }, [onPromptChange]);

  const cleanupSession = useCallback(async (nextStatus: VoiceInputStatus = "idle") => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) {
      setStatus(nextStatus);
      return;
    }

    session.active = false;
    session.worklet.port.onmessage = null;
    session.worklet.disconnect();
    session.source.disconnect();
    if (
      session.socket.readyState === WebSocket.OPEN ||
      session.socket.readyState === WebSocket.CONNECTING
    ) {
      session.socket.close();
    }
    for (const track of session.stream.getTracks()) {
      track.stop();
    }
    await session.audioContext.close().catch(() => undefined);
    setStatus(nextStatus);
  }, []);

  const applySegments = useCallback(
    (session: VoiceInputSession, rawSegments: ReadonlyArray<unknown>) => {
      const nextLiveSegments = parseVoiceSegments(rawSegments).filter((segment) =>
        isSegmentAfterBaseline(segment, session.segmentBaselineEnd),
      );
      if (nextLiveSegments.length === 0) {
        return;
      }

      const droppedSegments = droppedLiveSegments(session.liveSegments, nextLiveSegments);
      const droppedTranscript = textFromVoiceSegments(droppedSegments);
      if (droppedTranscript) {
        session.committedTranscript = mergeVoiceTranscript(
          session.committedTranscript,
          droppedTranscript,
        );
      }

      session.liveSegments = nextLiveSegments;
      const liveTranscript = textFromVoiceSegments(nextLiveSegments);
      const normalized = normalizeTranscript(
        mergeVoiceTranscript(session.committedTranscript, liveTranscript),
      );
      if (!normalized || normalized === session.lastTranscript) {
        return;
      }

      session.lastTranscript = normalized;
      const nextPrompt = mergeVoiceTranscript(session.basePrompt, normalized);
      onPromptChangeRef.current(nextPrompt);
    },
    [],
  );

  const handleWhisperLiveMessage = useCallback(
    (session: VoiceInputSession, raw: MessageEvent) => {
      const message = parseWhisperLiveMessage(raw.data);
      if (!message) {
        return;
      }
      if (typeof message.uid === "string" && message.uid !== session.uid) {
        return;
      }
      if (message.message === "SERVER_READY") {
        setStatus("listening");
        setErrorMessage(null);
        return;
      }
      if (Array.isArray(message.segments)) {
        applySegments(session, message.segments);
      }
    },
    [applySegments],
  );

  const stop = useCallback(async () => {
    startupGenerationRef.current += 1;
    isStartingRef.current = false;
    await cleanupSession("idle");
  }, [cleanupSession]);

  const resetTranscript = useCallback((nextBasePrompt = getPromptRef.current()) => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    session.basePrompt = nextBasePrompt;
    session.committedTranscript = "";
    session.lastTranscript = "";
    session.segmentBaselineEnd = maxSegmentEnd(session.liveSegments);
    session.liveSegments = [];
  }, []);

  const start = useCallback(async () => {
    if (disabledRef.current || sessionRef.current || isStartingRef.current) {
      return;
    }

    const startupGeneration = startupGenerationRef.current + 1;
    startupGenerationRef.current = startupGeneration;
    isStartingRef.current = true;
    setStatus("connecting");
    setErrorMessage(null);
    let pendingStream: MediaStream | null = null;
    let pendingAudioContext: AudioContext | null = null;
    let pendingSource: MediaStreamAudioSourceNode | null = null;
    let pendingWorklet: AudioWorkletNode | null = null;
    let pendingSocket: WebSocket | null = null;
    try {
      assertVoiceCaptureAvailable();
      pendingStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      assertStartupActive(startupGenerationRef, startupGeneration);
      const AudioContextClass = getAudioContextClass();
      pendingAudioContext = new AudioContextClass();
      if (!pendingAudioContext.audioWorklet) {
        throw new Error("This browser does not support AudioWorklet capture.");
      }
      await pendingAudioContext.audioWorklet.addModule("/voice-capture-worklet.js");
      assertStartupActive(startupGenerationRef, startupGeneration);

      pendingSource = pendingAudioContext.createMediaStreamSource(pendingStream);
      pendingWorklet = new AudioWorkletNode(pendingAudioContext, "voice-capture");
      const socket = await openWhisperLiveSocket({
        uid: randomSessionId(),
        language,
        model,
        url: whisperLiveWsUrlRef.current,
      });
      pendingSocket = socket.socket;
      assertStartupActive(startupGenerationRef, startupGeneration);

      const session: VoiceInputSession = {
        uid: socket.uid,
        basePrompt: getPromptRef.current(),
        stream: pendingStream,
        audioContext: pendingAudioContext,
        source: pendingSource,
        worklet: pendingWorklet,
        socket: socket.socket,
        active: true,
        committedTranscript: "",
        liveSegments: [],
        segmentBaselineEnd: 0,
        lastTranscript: "",
      };
      sessionRef.current = session;
      isStartingRef.current = false;

      socket.socket.onmessage = (event) => handleWhisperLiveMessage(session, event);
      socket.socket.onclose = () => {
        if (session.active) {
          void cleanupSession("idle");
        }
      };
      socket.socket.onerror = () => {
        if (session.active) {
          setErrorMessage("WhisperLive connection failed.");
          void cleanupSession("error");
        }
      };

      pendingStream = null;
      pendingAudioContext = null;
      pendingSource = null;
      pendingWorklet = null;
      pendingSocket = null;

      session.worklet.port.onmessage = (event: MessageEvent<VoiceCaptureWorkletMessage>) => {
        if (!session.active || socket.socket.readyState !== WebSocket.OPEN) {
          return;
        }
        const samples = event.data.samples;
        const sampleRate = event.data.sampleRate;
        if (!(samples instanceof Float32Array) || typeof sampleRate !== "number") {
          return;
        }
        const frame = resampleTo16k(samples, sampleRate);
        socket.socket.send(frame.buffer);
      };

      session.source.connect(session.worklet);
      session.worklet.connect(session.audioContext.destination);
      await session.audioContext.resume().catch(() => undefined);
    } catch (error) {
      const wasCancelled =
        error === STARTUP_CANCELLED || startupGenerationRef.current !== startupGeneration;
      isStartingRef.current = false;
      if (!wasCancelled) {
        setErrorMessage(error instanceof Error ? error.message : "Voice input failed.");
      }
      if (
        pendingSocket?.readyState === WebSocket.OPEN ||
        pendingSocket?.readyState === WebSocket.CONNECTING
      ) {
        pendingSocket.close();
      }
      pendingWorklet?.disconnect();
      pendingSource?.disconnect();
      for (const track of pendingStream?.getTracks() ?? []) {
        track.stop();
      }
      await pendingAudioContext?.close().catch(() => undefined);
      await cleanupSession(wasCancelled ? "idle" : "error");
    }
  }, [cleanupSession, handleWhisperLiveMessage, language, model]);

  const toggle = useCallback(() => {
    if (sessionRef.current || isStartingRef.current) {
      void stop();
      return;
    }
    void start();
  }, [start, stop]);

  useEffect(() => {
    if (disabled && sessionRef.current) {
      void stop();
    }
  }, [disabled, stop]);

  useEffect(
    () => () => {
      void cleanupSession("idle");
    },
    [cleanupSession],
  );

  return {
    status,
    errorMessage,
    isListening: status === "listening" || status === "connecting",
    toggle,
    stop,
    resetTranscript,
  };
}

function getAudioContextClass(): typeof AudioContext {
  const windowWithWebkit = window as typeof window & {
    readonly webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextClass = window.AudioContext ?? windowWithWebkit.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("This browser does not support Web Audio capture.");
  }
  return AudioContextClass;
}

function assertVoiceCaptureAvailable() {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new Error("Voice input is only available in a browser.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    if (!window.isSecureContext) {
      throw new Error("Microphone access requires HTTPS or localhost.");
    }
    throw new Error("This browser does not expose microphone capture.");
  }
  getAudioContextClass();
}

function assertStartupActive(
  startupGenerationRef: { readonly current: number },
  startupGeneration: number,
) {
  if (startupGenerationRef.current !== startupGeneration) {
    throw STARTUP_CANCELLED;
  }
}

function resolveWhisperLiveWsUrl(configuredUrl: string): string {
  const trimmedConfiguredUrl = configuredUrl.trim();
  if (trimmedConfiguredUrl) {
    return trimmedConfiguredUrl;
  }

  const envUrl = import.meta.env.VITE_WHISPERLIVE_WS_URL?.trim();
  return envUrl || DEFAULT_WHISPERLIVE_WS_URL;
}

async function openWhisperLiveSocket({
  uid,
  language,
  model,
  url,
}: {
  readonly uid: string;
  readonly language: string;
  readonly model: string;
  readonly url: string;
}): Promise<{ readonly uid: string; readonly socket: WebSocket }> {
  const socket = new WebSocket(resolveWhisperLiveWsUrl(url));
  socket.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          uid,
          language: language.trim() || null,
          task: "transcribe",
          model,
          use_vad: true,
          send_last_n_segments: 12,
          no_speech_thresh: 0.45,
          clip_audio: false,
          same_output_threshold: 2,
          enable_translation: false,
          target_language: "en",
        }),
      );
      resolve();
    };
    socket.onerror = () => reject(new Error("Unable to connect to WhisperLive."));
  });

  return { uid, socket };
}

function parseWhisperLiveMessage(data: unknown): WhisperLiveMessage | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as WhisperLiveMessage;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function parseVoiceSegments(segments: ReadonlyArray<unknown>): VoiceSegment[] {
  const parsedSegments: VoiceSegment[] = [];
  for (const rawSegment of segments) {
    const segment = rawSegment as WhisperLiveSegment;
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!text) {
      continue;
    }

    parsedSegments.push({
      key: segmentKey(segment, parsedSegments.length),
      text,
      endSeconds: numericSegmentBoundary(segment.end),
    });
  }
  return parsedSegments;
}

function isSegmentAfterBaseline(segment: VoiceSegment, segmentBaselineEnd: number): boolean {
  if (segmentBaselineEnd <= 0 || segment.endSeconds === null) {
    return true;
  }
  return segment.endSeconds > segmentBaselineEnd + 0.05;
}

function textFromVoiceSegments(segments: ReadonlyArray<VoiceSegment>): string {
  const parts: string[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (text && parts[parts.length - 1] !== text) {
      parts.push(text);
    }
  }
  return parts.join(" ").trim();
}

function droppedLiveSegments(
  previousSegments: ReadonlyArray<VoiceSegment>,
  nextSegments: ReadonlyArray<VoiceSegment>,
): VoiceSegment[] {
  if (previousSegments.length === 0 || nextSegments.length === 0) {
    return [];
  }

  const overlapStart = firstPreviousSegmentKeptInNextWindow(previousSegments, nextSegments);
  if (overlapStart === null) {
    return [];
  }
  return previousSegments.slice(0, overlapStart);
}

function firstPreviousSegmentKeptInNextWindow(
  previousSegments: ReadonlyArray<VoiceSegment>,
  nextSegments: ReadonlyArray<VoiceSegment>,
): number | null {
  const nextKeys = new Set(nextSegments.map((segment) => segment.key));
  for (let index = 0; index < previousSegments.length; index += 1) {
    if (nextKeys.has(previousSegments[index]!.key)) {
      return index;
    }
  }
  return null;
}

function segmentKey(segment: WhisperLiveSegment, fallbackIndex: number): string {
  const start = numericSegmentBoundary(segment.start);
  const end = numericSegmentBoundary(segment.end);
  if (start !== null || end !== null) {
    return `${formatSegmentBoundary(start)}:${formatSegmentBoundary(end)}`;
  }
  const text = typeof segment.text === "string" ? segment.text.trim() : "";
  return `text:${fallbackIndex}:${text}`;
}

function numericSegmentBoundary(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }
  return numberValue;
}

function formatSegmentBoundary(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

function maxSegmentEnd(segments: ReadonlyArray<VoiceSegment>): number {
  let maxEnd = 0;
  for (const segment of segments) {
    if (segment.endSeconds !== null && segment.endSeconds > maxEnd) {
      maxEnd = segment.endSeconds;
    }
  }
  return maxEnd;
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function mergeVoiceTranscript(basePrompt: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) {
    return basePrompt;
  }
  if (!basePrompt.trim()) {
    return trimmedTranscript;
  }
  if (/\s$/u.test(basePrompt)) {
    return `${basePrompt}${trimmedTranscript}`;
  }
  return `${basePrompt} ${trimmedTranscript}`;
}

function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) {
    return new Float32Array(input);
  }
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, input.length - 1);
    const weight = sourceIndex - left;
    output[index] = input[left]! * (1 - weight) + input[right]! * weight;
  }
  return output;
}

function randomSessionId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
