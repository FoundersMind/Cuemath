/**
 * Entry: wires modules, registers hooks to avoid circular imports.
 * TTS: clauses start as SSE `sentence` events (parallel with typing); AudioContext warmed on Begin.
 */
import { el } from "./js/dom.js";
import { health } from "./js/api.js";
import { syncReadinessUi } from "./js/readiness.js";
import { registerStartRecording } from "./js/listen.js";
import {
  startRecording,
  stopRecordingAndSend,
  registerSendCandidateMessage,
} from "./js/recording.js";
import { hardStopAllSpeech, warmTtsPlayback } from "./js/tts.js";
import { startInterview, sendCandidateMessage } from "./js/messages.js";
import { toast } from "./js/toast.js";
import { state } from "./js/state.js";
import { initWelcomeMicCheck } from "./js/mic-check.js";

registerStartRecording(startRecording);
initWelcomeMicCheck();
registerSendCandidateMessage(sendCandidateMessage);

function updateBeginEnabled() {
  syncReadinessUi();
}

function clearNameFieldError() {
  const nameInput = el("candidateName");
  nameInput?.classList.remove("is-invalid");
}

el("consent").addEventListener("change", updateBeginEnabled);
el("candidateName").addEventListener("input", () => {
  clearNameFieldError();
  const err = el("welcomeError");
  if (err && el("candidateName").value.trim().length > 0) err.classList.add("d-none");
  updateBeginEnabled();
});
syncReadinessUi();

el("btnBegin").addEventListener("click", () => {
  const nameInput = el("candidateName");
  const welcomeErr = el("welcomeError");

  welcomeErr.classList.add("d-none");
  clearNameFieldError();

  if (state.serverUnreachable || !state.serverInterviewReady) {
    welcomeErr.textContent = state.serverUnreachable
      ? "We can’t reach the server. Check your connection and that the app is running."
      : "The interview server isn’t configured (OpenAI API key missing).";
    welcomeErr.classList.remove("d-none");
    toast(welcomeErr.textContent, { kind: "danger", title: "Not ready" });
    return;
  }

  if (!state.welcomeMicCheckPassed) {
    welcomeErr.textContent =
      "Please use the microphone test above (Record → Stop) until we detect your voice — then you can start.";
    welcomeErr.classList.remove("d-none");
    el("btnMicTestRecord")?.scrollIntoView({ behavior: "smooth", block: "center" });
    toast("Complete the microphone test above first.", { kind: "warning", title: "Mic check required" });
    return;
  }

  if (!el("consent").checked) {
    welcomeErr.textContent = "Please read and check the consent box above to continue.";
    welcomeErr.classList.remove("d-none");
    el("consent").focus();
    toast("Consent is required to start the interview.", { kind: "warning", title: "Almost there" });
    return;
  }

  const name = (nameInput?.value || "").trim();
  if (!name) {
    nameInput?.classList.add("is-invalid");
    welcomeErr.textContent = "Please enter your name so we can start your interview.";
    welcomeErr.classList.remove("d-none");
    nameInput?.focus();
    nameInput?.scrollIntoView({ behavior: "smooth", block: "center" });
    toast("Enter your name in the field above, then try again.", { kind: "warning", title: "Name required" });
    return;
  }

  void (async () => {
    try {
      await warmTtsPlayback();
      await startInterview();
    } catch (e) {
      toast(e?.message || "Could not begin.", { kind: "danger", title: "Begin failed" });
    }
  })();
});

el("btnMicStart").addEventListener("click", () => void startRecording());
el("btnMicStop").addEventListener("click", () => void stopRecordingAndSend());

el("btnEndInterview")?.addEventListener("click", () => {
  // Idempotent: allow only one end request.
  if (state.endInterviewRequested) return;
  // Safety: don't allow end while interviewer audio is playing.
  if (state.speaking) {
    toast("Please wait until the interviewer finishes speaking, then try ending the interview.", {
      kind: "warning",
      title: "Interviewer speaking",
    });
    return;
  }
  state.endInterviewRequested = true;
  el("btnEndInterview").disabled = true;
  // Prevent audio collision: stop any current/queued interviewer speech before requesting end.
  hardStopAllSpeech();
  // Ask the AI to handle early ending with a short check-in.
  void sendCandidateMessage("[[CANDIDATE_REQUEST_END]]");
});

// Interview topbar: elapsed timer only (no question progress — avoids sync/UI churn).
let interviewStartedAt = null;
let timerInterval = null;
let endBtnInterval = null;

function syncEndInterviewButton() {
  const btn = el("btnEndInterview");
  const hint = el("endInterviewHint");
  const status = el("interviewStatusLine");
  if (status) {
    if (state.interviewEnded) status.textContent = "Complete";
    else if (state.endInterviewRequested) status.textContent = "Wrapping up";
    else status.textContent = "Voice interview";
  }
  if (!btn) return;
  const disabled = Boolean(state.endInterviewRequested || state.speaking);
  btn.disabled = disabled;
  if (hint) hint.classList.toggle("d-none", !state.speaking);
  btn.title = state.speaking
    ? "Please wait until the interviewer finishes speaking."
    : state.endInterviewRequested
      ? "Ending interview…"
      : "End the interview";
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function updateInterviewTimer() {
  const timer = el("liveTimer");
  if (timer && interviewStartedAt) timer.textContent = fmtTime(Date.now() - interviewStartedAt);
}

function ensureTimerRunning() {
  if (timerInterval) return;
  timerInterval = window.setInterval(updateInterviewTimer, 1000);
}

function onInterviewVisible() {
  if (!interviewStartedAt) interviewStartedAt = Date.now();
  if (!state.interviewStartedAt) state.interviewStartedAt = interviewStartedAt;
  ensureTimerRunning();
  updateInterviewTimer();
  if (!endBtnInterval) endBtnInterval = window.setInterval(syncEndInterviewButton, 200);
  syncEndInterviewButton();
}

// Observe screen visibility without touching flow logic.
const interviewScreen = el("screenInterview");
if (interviewScreen) {
  const mo = new MutationObserver(() => {
    if (!interviewScreen.classList.contains("d-none")) onInterviewVisible();
  });
  mo.observe(interviewScreen, { attributes: true, attributeFilter: ["class"] });
}

const log = el("transcriptLog");

// Ensure transcript starts at latest when interview becomes visible.
if (interviewScreen) {
  const moScroll = new MutationObserver(() => {
    if (!interviewScreen.classList.contains("d-none")) {
      window.setTimeout(() => scrollToLatest(true), 0);
    }
  });
  moScroll.observe(interviewScreen, { attributes: true, attributeFilter: ["class"] });
}

// Transcript UX: smart auto-scroll + "Jump to latest".
const jumpBtn = el("btnJumpLatest");
let userPinnedUp = false;
let lastNearBottom = true;

function isNearBottom(node) {
  const thresholdPx = 48;
  return node.scrollHeight - node.scrollTop - node.clientHeight < thresholdPx;
}

function updateJumpVisibility() {
  if (!log || !jumpBtn) return;
  const near = isNearBottom(log);
  lastNearBottom = near;
  userPinnedUp = !near;
  jumpBtn.classList.toggle("cue-jump--hidden", near);
}

function scrollToLatest(force = false) {
  if (!log) return;
  if (!force && userPinnedUp) return;
  // Important: DO NOT use scrollIntoView() here — it can scroll the whole page.
  // We only want to scroll the transcript panel itself.
  requestAnimationFrame(() => {
    // Force to the very bottom (extra buffer to account for padding/shadows).
    log.scrollTop = log.scrollHeight + 9999;
    updateJumpVisibility();
  });
}

log?.addEventListener("scroll", () => updateJumpVisibility(), { passive: true });
jumpBtn?.addEventListener("click", () => scrollToLatest(true));

// Initialize pinned/near-bottom state once.
updateJumpVisibility();

// When new messages arrive, auto-scroll only if user is already near bottom.
if (log) {
  const mo3 = new MutationObserver(() => {
    // If the user was at (or near) the bottom, keep them at the bottom as new messages come in.
    // If they scrolled up, don't fight them — show the Jump button instead.
    if (lastNearBottom) scrollToLatest(true);
    else updateJumpVisibility();
  });
  mo3.observe(log, { childList: true, subtree: true });
}

el("btnCopyTranscript")?.addEventListener("click", async () => {
  try {
    const lines = (state.messages || [])
      .filter((m) => m?.role === "user" || m?.role === "assistant")
      .map((m) => `${m.role === "assistant" ? "Interviewer" : "You"}: ${String(m.content || "").trim()}`)
      .filter((s) => s.length > 0);
    const text = lines.join("\n\n") || "No transcript yet.";
    await navigator.clipboard.writeText(text);
    toast("Transcript copied to clipboard.", { kind: "success", title: "Copied" });
  } catch {
    toast("Could not copy. Try selecting the conversation and copying manually.", {
      kind: "warning",
      title: "Copy failed",
    });
  }
});

// Keyboard shortcut: Space to toggle recording (when not typing).
window.addEventListener("keydown", (ev) => {
  if (ev.code !== "Space") return;
  const t = ev.target;
  const isTyping =
    t &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (isTyping) return;
  const micStart = el("btnMicStart");
  const micStop = el("btnMicStop");
  if (!micStart || !micStop) return;
  if (!micStop.disabled) {
    ev.preventDefault();
    micStop.click();
  } else if (!micStart.disabled) {
    ev.preventDefault();
    micStart.click();
  }
});

health();
