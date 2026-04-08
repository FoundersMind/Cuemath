import { TTS_LEAD_IN_MS } from "./config.js";
import { state, tts } from "./state.js";
import { syncAvatar } from "./ui.js";
import { scheduleAutoListen } from "./listen.js";

let ttsPlaybackContext = null;
let ttsActiveSource = null;
/** Indexes SSE `sentence` chunks within one assistant turn (lead-in only on first). */
let ttsChunkIndex = 0;
let ttsGeneration = 0;

export function resetStreamingTtsTurn() {
  ttsChunkIndex = 0;
}

export function bumpTtsGeneration() {
  ttsGeneration += 1;
}

export function getTtsPlaybackContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ttsPlaybackContext || ttsPlaybackContext.state === "closed") {
    ttsPlaybackContext = new AC();
  }
  return ttsPlaybackContext;
}

/** Call after user gesture (Begin) so first decode/play is not blocked by suspend. */
export async function warmTtsPlayback() {
  const ctx = getTtsPlaybackContext();
  if (ctx?.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
}

export function stopTtsOutput() {
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
    } catch {
      /* ignore */
    }
    state.currentAudio = null;
  }
  if (ttsActiveSource) {
    try {
      ttsActiveSource.stop();
    } catch {
      /* ignore */
    }
    ttsActiveSource = null;
  }
}

export function hardStopAllSpeech() {
  // Stop both WebAudio/HTML audio and speechSynthesis.
  bumpTtsGeneration();
  stopTtsOutput();
  try {
    window.speechSynthesis?.cancel?.();
  } catch {
    /* ignore */
  }
  state.speaking = false;
  syncAvatar();
}

function waitAudioCanPlayThrough(media) {
  return new Promise((resolve, reject) => {
    if (media.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      resolve();
      return;
    }
    const ok = () => resolve();
    const bad = () => reject(new Error("audio load"));
    media.addEventListener("canplaythrough", ok, { once: true });
    media.addEventListener("error", bad, { once: true });
    try {
      media.load();
    } catch {
      /* ignore */
    }
  });
}

/** Start TTS network fetch immediately; returns a Promise that resolves to the audio Blob. */
export function startTtsBlobPrefetch(text, sessionId) {
  const sid = sessionId ?? state.sessionId;
  return (async () => {
    const payload = { text, session_id: sid };
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("TTS failed");
    return r.blob();
  })();
}

async function playTtsBlob(blob, onended, { useLeadIn = true, leadInMs } = {}) {
  const ctx = getTtsPlaybackContext();
  if (ctx) {
    try {
      if (ctx.state === "suspended") await ctx.resume();
      const raw = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(raw.slice(0));
      const rate = decoded.sampleRate;
      const ch = decoded.numberOfChannels;
      let leadMs = 0;
      if (useLeadIn) {
        leadMs =
          typeof leadInMs === "number" && leadInMs >= 0
            ? leadInMs
            : TTS_LEAD_IN_MS;
      }
      const leadSamples =
        leadMs > 0 ? Math.max(1, Math.ceil((leadMs / 1000) * rate)) : 0;

      let bufferToPlay = decoded;
      if (leadSamples > 0) {
        const out = ctx.createBuffer(ch, decoded.length + leadSamples, rate);
        for (let c = 0; c < ch; c++) {
          out.getChannelData(c).set(decoded.getChannelData(c), leadSamples);
        }
        bufferToPlay = out;
      }

      const src = ctx.createBufferSource();
      src.buffer = bufferToPlay;
      src.connect(ctx.destination);
      ttsActiveSource = src;
      src.onended = () => {
        if (ttsActiveSource === src) ttsActiveSource = null;
        onended();
      };
      src.start(0);
      return;
    } catch {
      /* use HTML audio */
    }
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = url;
  audio.playbackRate = 1;
  state.currentAudio = audio;
  try {
    await waitAudioCanPlayThrough(audio);
    await audio.play();
  } catch {
    URL.revokeObjectURL(url);
    state.currentAudio = null;
    throw new Error("TTS playback");
  }
  audio.onended = () => {
    URL.revokeObjectURL(url);
    state.currentAudio = null;
    onended();
  };
  audio.onerror = () => {
    URL.revokeObjectURL(url);
    state.currentAudio = null;
    onended();
  };
}

export function speakBrowser(text, onend, options = {}) {
  const skipAutoListen = options.skipAutoListen === true;
  window.speechSynthesis.cancel();
  state.speaking = true;
  syncAvatar();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  u.pitch = 1;
  const done = () => {
    state.speaking = false;
    syncAvatar();
    if (onend) onend();
    if (!skipAutoListen && !state.interviewEnded) scheduleAutoListen();
  };
  u.onend = done;
  u.onerror = done;
  window.speechSynthesis.speak(u);
}

/**
 * Play interviewer audio from a prefetch promise (fetch runs in parallel with SSE tail).
 */
export async function speakInterviewerFromBlobPromise(blobPromise, textFallback, onend, options = {}) {
  const skipAutoListen = options.skipAutoListen === true;
  stopTtsOutput();
  state.speaking = true;
  syncAvatar();
  const finish = () => {
    state.speaking = false;
    syncAvatar();
    if (onend) onend();
    if (!skipAutoListen && !state.interviewEnded) scheduleAutoListen();
  };
  try {
    const blob = await blobPromise;
    if (typeof options.beforePlay === "function") options.beforePlay();
    try {
      await playTtsBlob(blob, finish, {
        useLeadIn: options.useLeadIn !== false,
        leadInMs: options.leadInMs,
      });
    } catch {
      state.speaking = false;
      syncAvatar();
      speakBrowser(textFallback, onend, { skipAutoListen });
    }
  } catch {
    state.speaking = false;
    syncAvatar();
    speakBrowser(textFallback, onend, { skipAutoListen });
  }
}

export async function speakInterviewer(text, onend, options = {}) {
  return speakInterviewerFromBlobPromise(startTtsBlobPrefetch(text, state.sessionId), text, onend, {
    ...options,
    useLeadIn: options.useLeadIn !== false,
  });
}

/** Chain one assistant speak after previous audio finishes (full reply fallback). */
export function enqueueAssistantSpeak(reply, skipAutoListen = true) {
  const blobP = startTtsBlobPrefetch(reply, state.sessionId);
  enqueueAssistantSpeakPrefetch(blobP, reply, skipAutoListen);
}

/**
 * Same as enqueueAssistantSpeak but uses an already-started /api/tts fetch (e.g. started on SSE `done`
 * so network + MP3 run in parallel with the on-screen typewriter, shrinking the gap before speech).
 */
export function enqueueAssistantSpeakPrefetch(
  blobPromise,
  textFallback,
  skipAutoListen = true,
  playOptions = {},
) {
  const gen = ttsGeneration;
  tts.queue = tts.queue.then(
    () =>
      new Promise((resolve) => {
        // Only cancel if a newer generation superseded this playback.
        // (Used to stop collisions; still allows the end-interview reply to be spoken.)
        if (gen !== ttsGeneration) {
          resolve();
          return;
        }
        void speakInterviewerFromBlobPromise(blobPromise, textFallback, resolve, {
          skipAutoListen,
          useLeadIn: true,
          leadInMs: playOptions.leadInMs,
        });
      }),
  );
}

/**
 * Split final reply into TTS clauses (same `.?!` boundaries as server; used when no streaming sentences).
 */
export function splitReplyIntoTtsClauses(reply) {
  let rest = reply.replace(/\[\[END_INTERVIEW\]\]/gi, "").trim();
  const out = [];
  while (rest.length >= 8) {
    const m = rest.match(/[.!?](?:\s+|$)/);
    if (!m || m.index === undefined) break;
    const end = m.index + m[0].length;
    const frag = rest.slice(0, end).trim();
    rest = rest.slice(end).trimStart();
    if (frag.length >= 3) out.push(frag);
  }
  const tail = rest.replace(/\[\[END_INTERVIEW\]\]/gi, "").trim();
  if (tail.length >= 3) out.push(tail);
  const oneLine = reply.replace(/\[\[END_INTERVIEW\]\]/gi, "").trim();
  if (out.length === 0 && oneLine.length >= 2) out.push(oneLine);
  return out;
}

export function enqueueAssistantReplyClauses(reply, streamDisplay = null, skipAutoListen = true) {
  const clauses = splitReplyIntoTtsClauses(reply);
  for (const c of clauses) {
    enqueueAssistantSpeakChunk(c, skipAutoListen, streamDisplay);
  }
}

/**
 * One completed sentence from SSE — prefetch + queue so speech overlaps with later tokens.
 */
export function enqueueAssistantSpeakChunk(fragment, skipAutoListen = true, streamDisplay = null) {
  const text = fragment.replace(/\[\[END_INTERVIEW\]\]/gi, "").trim();
  if (text.length < 2) return;
  const idx = ttsChunkIndex;
  ttsChunkIndex += 1;
  const blobP = startTtsBlobPrefetch(text, state.sessionId);
  const sync = streamDisplay && typeof streamDisplay.revealThroughClause === "function";
  const gen = ttsGeneration;
  tts.queue = tts.queue.then(
    () =>
      new Promise((resolve) => {
        // Only cancel if a newer generation superseded this playback.
        if (gen !== ttsGeneration) {
          resolve();
          return;
        }
        void speakInterviewerFromBlobPromise(blobP, text, resolve, {
          skipAutoListen,
          useLeadIn: idx === 0,
          beforePlay: sync ? () => streamDisplay.revealThroughClause(text) : undefined,
        });
      }),
  );
}
