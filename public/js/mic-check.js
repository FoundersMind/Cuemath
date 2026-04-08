/**
 * Optional welcome-screen mic test: record a short clip locally and play it back (no upload).
 */
import { el } from "./dom.js";
import { toast } from "./toast.js";
import { state } from "./state.js";
import { syncReadinessUi } from "./readiness.js";

const MAX_RECORD_MS = 8000;

let testStream = null;
let testRecorder = null;
let testChunks = [];
let testBlob = null;
let testObjectUrl = null;
let maxRecordTimer = null;

function pickTestMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const t of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function setStatus(msg) {
  const s = el("micTestStatus");
  if (s) s.textContent = msg || "";
}

function stopPlayback() {
  const a = el("micTestAudio");
  if (a) {
    a.pause();
    a.currentTime = 0;
  }
}

function resetRecorderUi() {
  const rec = el("btnMicTestRecord");
  const stop = el("btnMicTestStop");
  const play = el("btnMicTestPlay");
  if (rec) rec.disabled = false;
  if (stop) stop.disabled = true;
  if (play) play.disabled = !testBlob || testBlob.size < 120;
}

async function startMicTest() {
  if (!el("btnMicTestRecord")) return;
  if (testRecorder?.state === "recording") return;

  stopPlayback();
  if (testObjectUrl) {
    URL.revokeObjectURL(testObjectUrl);
    testObjectUrl = null;
  }
  testBlob = null;
  resetRecorderUi();
  if (el("btnMicTestPlay")) el("btnMicTestPlay").disabled = true;

  try {
    testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Allow microphone access in your browser to run this check.", {
      kind: "warning",
      title: "Microphone",
    });
    setStatus("Microphone not available — check permissions.");
    return;
  }

  testChunks = [];
  const mime = pickTestMimeType();
  try {
    testRecorder = new MediaRecorder(testStream, mime ? { mimeType: mime } : undefined);
  } catch {
    testStream.getTracks().forEach((t) => t.stop());
    testStream = null;
    toast("Recording isn’t supported in this browser for the mic check.", { kind: "danger", title: "Mic check" });
    return;
  }

  testRecorder.ondataavailable = (e) => {
    if (e.data.size) testChunks.push(e.data);
  };
  testRecorder.onstop = () => {
    const recMime = testRecorder?.mimeType || "audio/webm";
    testBlob = new Blob(testChunks, { type: recMime });
    testChunks = [];
    testStream?.getTracks().forEach((t) => t.stop());
    testStream = null;
    testRecorder = null;

    if (el("btnMicTestRecord")) el("btnMicTestRecord").disabled = false;
    if (el("btnMicTestStop")) el("btnMicTestStop").disabled = true;
    const small = testBlob.size < 120;
    if (el("btnMicTestPlay")) el("btnMicTestPlay").disabled = small;
    if (!small) {
      const firstPass = !state.welcomeMicCheckPassed;
      state.welcomeMicCheckPassed = true;
      syncReadinessUi();
      if (firstPass) {
        toast("Microphone check passed — you can start the interview when you’re ready.", {
          kind: "success",
          title: "Mic OK",
        });
      }
    }
    setStatus(
      small
        ? "We barely heard anything — try speaking a bit louder or closer to the mic."
        : "Mic captured your voice — tap Play back to hear it, or start the interview.",
    );
  };

  testRecorder.start();
  if (el("btnMicTestRecord")) el("btnMicTestRecord").disabled = true;
  if (el("btnMicTestStop")) el("btnMicTestStop").disabled = false;
  setStatus("Recording… say a short sentence (we stop automatically after 8 seconds).");

  maxRecordTimer = window.setTimeout(() => {
    if (testRecorder?.state === "recording") stopMicTestRecord();
  }, MAX_RECORD_MS);
}

function stopMicTestRecord() {
  if (maxRecordTimer != null) {
    window.clearTimeout(maxRecordTimer);
    maxRecordTimer = null;
  }
  if (testRecorder?.state === "recording") {
    try {
      testRecorder.requestData?.();
      testRecorder.stop();
    } catch {
      /* ignore */
    }
  }
}

function playMicTest() {
  if (!testBlob || testBlob.size < 120) return;
  stopPlayback();
  if (testObjectUrl) URL.revokeObjectURL(testObjectUrl);
  testObjectUrl = URL.createObjectURL(testBlob);
  const a = el("micTestAudio");
  if (!a) return;
  a.src = testObjectUrl;
  setStatus("Playing your recording…");
  a.onended = () => setStatus("Playback finished. Record again anytime.");
  void a.play().catch(() => {
    setStatus("Playback was blocked — click Play back again.");
    toast("Could not play audio. Try clicking Play back once more.", { kind: "warning", title: "Playback" });
  });
}

export function initWelcomeMicCheck() {
  el("btnMicTestRecord")?.addEventListener("click", () => void startMicTest());
  el("btnMicTestStop")?.addEventListener("click", () => stopMicTestRecord());
  el("btnMicTestPlay")?.addEventListener("click", () => playMicTest());
}
