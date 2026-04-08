import { el } from "./dom.js";
import { state } from "./state.js";

const AVATAR_LABELS = {
  idle: "Take your time — mic opens shortly after I finish.",
  speaking: "Speaking with you now…",
  listening: "I’m listening — pause when you’re done, or tap Stop.",
  thinking: "Taking that in…",
};

export function showScreen(name) {
  ["Welcome", "Interview"].forEach((s) => {
    const node = el(`screen${s}`);
    if (node) node.classList.toggle("d-none", s !== name);
  });
  document.body.classList.toggle("is-interview", name === "Interview");
  document.body.classList.toggle("is-results", false);
  // UX: ensure new screen starts at top (especially on laptop).
  try {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch {
    window.scrollTo(0, 0);
  }
}

export function syncAvatar() {
  const host = el("interviewerAvatar");
  const cap = el("avatarCaption");
  if (!host) return;

  let mode = "idle";
  if (state.transcribing || state.busy) mode = "thinking";
  else if (state.speaking) mode = "speaking";
  else if (state.isRecording) mode = "listening";

  host.classList.remove("avatar--idle", "avatar--speaking", "avatar--listening", "avatar--thinking");
  host.classList.add(`avatar--${mode}`);
  if (cap) cap.textContent = AVATAR_LABELS[mode];
}

export function setBusy(b) {
  state.busy = b;
  el("busyIndicator").classList.toggle("d-none", !b);
  syncAvatar();
}
