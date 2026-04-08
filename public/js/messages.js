import { el } from "./dom.js";
import { state, resetTtsQueue, tts } from "./state.js";
import { showScreen, setBusy, syncAvatar } from "./ui.js";
import { scheduleAutoListen } from "./listen.js";
import { ensureSession } from "./api.js";
import { consumeInterviewStreamBody } from "./sse.js";
import { resetStreamingTtsTurn } from "./tts.js";
import { endInterviewFlow } from "./flow.js";
import { primeInterviewMicrophone, startRecording } from "./recording.js";
import { LISTEN_MIC_RETRY_MS } from "./config.js";
import { toast } from "./toast.js";
import { ASSESS_PENDING_KEY, ASSESS_SNAPSHOT_KEY } from "./assessment.js";

function ensureChatHasEmptyState() {
  const log = el("transcriptLog");
  if (!log) return;
  if (log.childElementCount > 0) return;
  const empty = document.createElement("div");
  empty.className = "cm-chat-empty small";
  empty.textContent =
    "Your interview will appear here. If you don’t hear the interviewer, check your system volume and browser tab audio.";
  log.appendChild(empty);
}

function formatTime(d) {
  try {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function afterAssistantTurn(out) {
  await tts.queue;
  setBusy(false);
  if (out.ended) {
    endInterviewFlow();
    return;
  }
  scheduleAutoListen();
  setTimeout(() => {
    if (state.interviewEnded || state.busy || state.speaking || state.isRecording) return;
    void startRecording();
    const hint = el("micHint");
    if (hint)
      hint.textContent =
        "Microphone should be on — if you don’t see Recording…, tap Start recording to answer.";
  }, LISTEN_MIC_RETRY_MS);
}

function appendLog(role, text) {
  const log = el("transcriptLog");
  if (!log) return;

  const first = log.firstElementChild;
  if (first && first.classList.contains("cm-chat-empty")) first.remove();

  const lower = (role || "").toLowerCase();
  const isUser = lower === "you" || lower === "candidate";
  const wrap = document.createElement("div");
  wrap.className = `cm-msg ${isUser ? "cm-msg--user" : "cm-msg--assistant"}`;

  const bubble = document.createElement("div");
  bubble.className = "cm-bubble";
  bubble.textContent = text;

  const meta = document.createElement("div");
  meta.className = "cm-meta";

  const who = document.createElement("span");
  who.className = "cm-pill";
  who.textContent = isUser ? "You" : "Interviewer";

  const when = document.createElement("span");
  when.textContent = formatTime(new Date());

  meta.appendChild(who);
  meta.appendChild(when);
  wrap.appendChild(bubble);
  wrap.appendChild(meta);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

export async function startInterview() {
  showScreen("Interview");
  el("interviewerText").textContent = "Starting…";
  syncAvatar();
  setBusy(true);
  ensureChatHasEmptyState();
  try {
    await ensureSession();
    try {
      sessionStorage.removeItem(ASSESS_SNAPSHOT_KEY);
      sessionStorage.removeItem(ASSESS_PENDING_KEY);
    } catch {
      /* ignore */
    }
    await primeInterviewMicrophone();
    resetTtsQueue();
    const res = await fetch("/api/interview/start-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: state.sessionId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || res.statusText);
    }
    const out = await consumeInterviewStreamBody(res);
    const reply = out.reply || "";
    state.messages.push({ role: "assistant", content: reply });
    appendLog("Interviewer", reply);
    await afterAssistantTurn(out);
  } catch (e) {
    el("interviewerText").textContent = "Could not start. Check API key and try again.";
    setBusy(false);
    toast(e.message || "Could not start interview.", { kind: "danger", title: "Start failed" });
  }
}

export async function sendCandidateMessage(text) {
  if (!text.trim() || state.busy || state.interviewEnded) return;
  if (!state.sessionId) await ensureSession();
  const trimmed = text.trim();
  state.messages.push({ role: "user", content: trimmed });
  appendLog("You", trimmed);
  el("liveUserText").textContent = "—";
  setBusy(true);
  try {
    const msgs = state.messages.filter((m) => m.role === "user" || m.role === "assistant");
    resetTtsQueue();
    resetStreamingTtsTurn();
    const res = await fetch("/api/interview/message-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: state.sessionId,
        messages: msgs,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || res.statusText);
    }
    const out = await consumeInterviewStreamBody(res);
    const reply = out.reply || "";
    state.messages.push({ role: "assistant", content: reply });
    appendLog("Interviewer", reply);
    await afterAssistantTurn(out);
  } catch (e) {
    state.messages.pop();
    const log = el("transcriptLog");
    if (log.lastChild) log.removeChild(log.lastChild);
    el("liveUserText").textContent = "—";
    setBusy(false);
    toast(e.message || "Could not send your answer.", { kind: "danger", title: "Send failed" });
    if (!state.interviewEnded) el("btnMicStart").disabled = false;
  }
}
