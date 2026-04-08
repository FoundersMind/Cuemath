/** Application + recording state (mutated by UI / interview flow). */
export const state = {
  sessionId: null,
  messages: [],
  busy: false,
  interviewEnded: false,
  interviewStartedAt: null,
  interviewEndedAt: null,
  /** One getUserMedia stream for the whole interview (released when interview ends). */
  interviewMicStream: null,
  mediaRecorder: null,
  recordChunks: [],
  isRecording: false,
  speaking: false,
  currentAudio: null,
  transcribing: false,
  /** Web Audio graph for VAD only; kept open for the interview session. */
  vadAudioContext: null,
  vadSourceNode: null,
  analyser: null,
  vadRafId: null,
  vadHeardSound: false,
  vadLastLoudAt: 0,
  vadRecordingStartedAt: 0,
  stopRecordingInFlight: false,
  /** One-shot “check your mic” hint while recording with no VAD yet. */
  midListenNoVoiceHintShown: false,
  endInterviewRequested: false,
  assessmentInFlight: false,
  /** Set after first /api/health response (success or failure). */
  healthCheckComplete: false,
  serverUnreachable: false,
  /** OpenAI available on server (from health). */
  serverInterviewReady: false,
  /** User completed welcome mic test with audible capture (local only). */
  welcomeMicCheckPassed: false,
};

/**
 * FIFO chain for interviewer TTS (object so importers can append .then reliably).
 * ES module `import { x }` bindings are not reassignment-safe across files.
 */
export const tts = { queue: Promise.resolve() };

export function resetTtsQueue() {
  tts.queue = Promise.resolve();
}
