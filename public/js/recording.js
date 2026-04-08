import {
  VAD_SILENCE_END_MS,
  VAD_MIN_MS,
  VAD_RMS_THRESHOLD,
  LISTEN_NO_SPEECH_TIMEOUT_MS,
  LISTEN_NO_VOICE_HINT_MS,
  NO_CANDIDATE_REPLY_PLACEHOLDER,
} from "./config.js";
import { el } from "./dom.js";
import { state } from "./state.js";
import { syncAvatar } from "./ui.js";
import { ensureSession } from "./api.js";

function pickRecorderMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const t of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function stopVadLoop() {
  if (state.vadRafId != null) {
    cancelAnimationFrame(state.vadRafId);
    state.vadRafId = null;
  }
}

function vadTick() {
  if (!state.isRecording || !state.analyser) {
    state.vadRafId = null;
    return;
  }
  /** While Riley speaks, ignore levels so speaker bleed does not end the clip early. */
  if (state.speaking) {
    state.vadRafId = requestAnimationFrame(vadTick);
    return;
  }
  const now = performance.now();
  const buf = new Float32Array(state.analyser.fftSize);
  state.analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms > VAD_RMS_THRESHOLD) {
    state.vadHeardSound = true;
    state.vadLastLoudAt = now;
  }
  if (
    !state.vadHeardSound &&
    !state.midListenNoVoiceHintShown &&
    now - state.vadRecordingStartedAt >= LISTEN_NO_VOICE_HINT_MS
  ) {
    state.midListenNoVoiceHintShown = true;
    const live = state.interviewMicStream?.getTracks().some((t) => t.readyState === "live");
    el("micHint").textContent = live
      ? "We’re still not hearing speech. If you’re trying to answer, check the mic isn’t muted in your OS and for this site in the browser; otherwise we’ll move on shortly."
      : "Microphone doesn’t look active — check permissions or tap Start recording again.";
  }
  if (
    !state.vadHeardSound &&
    now - state.vadRecordingStartedAt >= LISTEN_NO_SPEECH_TIMEOUT_MS
  ) {
    state.vadRafId = null;
    void stopRecordingAsNoResponse();
    return;
  }
  if (
    state.vadHeardSound &&
    now - state.vadLastLoudAt >= VAD_SILENCE_END_MS &&
    now - state.vadRecordingStartedAt >= VAD_MIN_MS
  ) {
    state.vadRafId = null;
    void stopRecordingAndSend();
    return;
  }
  state.vadRafId = requestAnimationFrame(vadTick);
}

async function ensureInterviewMicStream() {
  if (state.interviewMicStream) {
    const live = state.interviewMicStream.getTracks().some((t) => t.readyState === "live");
    if (live) {
      if (!state.analyser || !state.vadAudioContext) {
        const ctx = new AudioContext();
        if (ctx.state === "suspended") await ctx.resume();
        const src = ctx.createMediaStreamSource(state.interviewMicStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.88;
        src.connect(analyser);
        state.vadAudioContext = ctx;
        state.vadSourceNode = src;
        state.analyser = analyser;
      }
      return state.interviewMicStream;
    }
    state.interviewMicStream = null;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.interviewMicStream = stream;
  const ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.88;
  src.connect(analyser);
  state.vadAudioContext = ctx;
  state.vadSourceNode = src;
  state.analyser = analyser;
  return stream;
}

/**
 * Acquire mic once and build VAD analyser; safe to call multiple times.
 * Call early (e.g. interview start) so the first answer is not blocked on permission.
 */
export async function primeInterviewMicrophone() {
  if (typeof MediaRecorder === "undefined") return;
  try {
    await ensureInterviewMicStream();
  } catch {
    /* startRecording will surface errors */
  }
}

/** Tear down mic + VAD when the interview finishes or user leaves. */
export function releaseInterviewMicrophone() {
  stopVadLoop();
  state.isRecording = false;
  el("listenIndicator").classList.add("d-none");
  const mr = state.mediaRecorder;
  state.mediaRecorder = null;
  try {
    if (mr && mr.state === "recording") mr.stop();
  } catch {
    /* ignore */
  }
  state.recordChunks = [];
  if (state.vadSourceNode) {
    try {
      state.vadSourceNode.disconnect();
    } catch {
      /* ignore */
    }
    state.vadSourceNode = null;
  }
  if (state.vadAudioContext) {
    try {
      void state.vadAudioContext.close();
    } catch {
      /* ignore */
    }
    state.vadAudioContext = null;
  }
  state.analyser = null;
  if (state.interviewMicStream) {
    state.interviewMicStream.getTracks().forEach((t) => t.stop());
    state.interviewMicStream = null;
  }
  el("btnMicStart").disabled = state.busy || state.interviewEnded;
  el("btnMicStop").disabled = true;
  syncAvatar();
}

export async function startRecording() {
  if (state.interviewEnded || state.busy || state.speaking) return;
  if (state.isRecording) return;
  if (typeof MediaRecorder === "undefined") {
    el("micHint").textContent = "MediaRecorder not supported in this browser. Try Chrome or Edge.";
    return;
  }
  try {
    await ensureSession();
  } catch (e) {
    el("micHint").textContent = e.message;
    return;
  }
  try {
    const stream = await ensureInterviewMicStream();
    state.recordChunks = [];
    const mime = pickRecorderMimeType();
    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    state.mediaRecorder = mr;
    mr.ondataavailable = (ev) => {
      if (ev.data.size) state.recordChunks.push(ev.data);
    };
    mr.onerror = () => {
      el("micHint").textContent = "Recording error.";
    };
    mr.start(250);
    if (!state.analyser) {
      el("micHint").textContent = "Audio setup incomplete — try again.";
      state.mediaRecorder = null;
      try {
        if (mr.state === "recording") mr.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    state.vadHeardSound = false;
    state.midListenNoVoiceHintShown = false;
    state.vadLastLoudAt = performance.now();
    state.vadRecordingStartedAt = performance.now();
    stopVadLoop();
    state.vadRafId = requestAnimationFrame(vadTick);

    state.isRecording = true;
    el("listenIndicator").classList.remove("d-none");
    el("btnMicStart").disabled = true;
    el("btnMicStop").disabled = false;
    el("liveUserText").textContent = "…";
    el("micHint").textContent =
      "Speak naturally. We’ll submit after a short pause once you start talking.";
    syncAvatar();
  } catch (e) {
    el("micHint").textContent = e.message || "Microphone permission denied.";
  }
}

/** Bound from messages after module load to avoid circular imports. */
let sendCandidateMessageRef = async (_text) => {};

export function registerSendCandidateMessage(fn) {
  sendCandidateMessageRef = fn;
}

/**
 * Mic was open but we never got meaningful voice (timeout) — skip Whisper; Riley gets a no-reply turn via placeholder.
 */
async function stopRecordingAsNoResponse() {
  if (state.stopRecordingInFlight) return;
  if (!state.isRecording || !state.mediaRecorder) return;
  state.stopRecordingInFlight = true;
  stopVadLoop();

  const mr = state.mediaRecorder;
  state.isRecording = false;
  el("listenIndicator").classList.add("d-none");
  el("btnMicStop").disabled = true;
  el("micHint").textContent = "No speech picked up — your interviewer will pick this turn back up.";
  state.transcribing = false;
  syncAvatar();

  state.mediaRecorder = null;
  await new Promise((resolve) => {
    mr.onstop = resolve;
    try {
      if (mr.state === "recording") mr.stop();
    } catch {
      resolve();
    }
  });

  state.recordChunks = [];
  el("liveUserText").textContent = "—";
  try {
    await sendCandidateMessageRef(NO_CANDIDATE_REPLY_PLACEHOLDER);
  } catch {
    /* sendCandidateMessage surfaces alert */
  } finally {
    state.stopRecordingInFlight = false;
    if (!state.busy && !state.interviewEnded) el("btnMicStart").disabled = false;
    syncAvatar();
  }
}

export async function stopRecordingAndSend() {
  if (state.stopRecordingInFlight) return;
  if (!state.isRecording || !state.mediaRecorder) return;
  state.stopRecordingInFlight = true;
  stopVadLoop();

  const heardSound = state.vadHeardSound;
  const mr = state.mediaRecorder;
  state.isRecording = false;
  el("listenIndicator").classList.add("d-none");
  el("btnMicStop").disabled = true;
  el("micHint").textContent = "Processing what you said…";
  state.transcribing = true;
  syncAvatar();

  await new Promise((resolve) => {
    mr.onstop = resolve;
    try {
      if (mr.state === "recording") mr.requestData?.();
    } catch {
      /* ignore */
    }
    try {
      mr.stop();
    } catch {
      resolve();
    }
  });

  state.mediaRecorder = null;

  const blobType =
    state.recordChunks[0]?.type || pickRecorderMimeType() || "audio/webm";
  const blob = new Blob(state.recordChunks, { type: blobType });
  state.recordChunks = [];

  if (blob.size < 300) {
    state.transcribing = false;
    state.stopRecordingInFlight = false;
    if (!heardSound) {
      el("micHint").textContent =
        "No speech picked up — your interviewer will pick this turn back up.";
      el("liveUserText").textContent = "—";
      try {
        await sendCandidateMessageRef(NO_CANDIDATE_REPLY_PLACEHOLDER);
      } catch {
        /* alert in sendCandidateMessage */
      }
      if (!state.busy && !state.interviewEnded) el("btnMicStart").disabled = false;
      syncAvatar();
      return;
    }
    el("micHint").textContent = "Recording too short — try again.";
    if (!state.busy && !state.interviewEnded) el("btnMicStart").disabled = false;
    syncAvatar();
    return;
  }

  try {
    const fd = new FormData();
    fd.append("audio", blob, "answer.webm");
    fd.append("session_id", state.sessionId);
    const r = await fetch("/api/transcribe", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    const t = (j.text || "").trim();
    el("liveUserText").textContent = t || "—";
    el("micHint").textContent = "";
    state.transcribing = false;
    syncAvatar();
    if (t) await sendCandidateMessageRef(t);
    else if (!heardSound) {
      el("micHint").textContent =
        "No speech picked up — your interviewer will pick this turn back up.";
      await sendCandidateMessageRef(NO_CANDIDATE_REPLY_PLACEHOLDER);
    } else {
      el("micHint").textContent = "No speech detected — try again.";
      if (!state.busy && !state.interviewEnded) el("btnMicStart").disabled = false;
      syncAvatar();
    }
  } catch (e) {
    state.transcribing = false;
    el("micHint").textContent = e.message;
    if (!state.busy && !state.interviewEnded) el("btnMicStart").disabled = false;
    syncAvatar();
  } finally {
    state.stopRecordingInFlight = false;
  }
}
