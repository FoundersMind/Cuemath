/**
 * Interview readiness: server/API health, mic check, name, consent.
 * Start stays disabled until all gates pass. Hero vs form status use different colors (form is on a light card).
 */
import { el } from "./dom.js";
import { state } from "./state.js";

function stripToneClasses(node) {
  if (!node) return;
  node.classList.remove(
    "text-white",
    "text-warning",
    "text-danger",
    "text-muted",
    "text-success",
    "fw-semibold",
  );
}

/** Status line in the dark hero — light text when all good. */
function applyHeroTone(node, tone) {
  stripToneClasses(node);
  if (tone === "ok") node.classList.add("text-white");
  else if (tone === "warn") node.classList.add("text-warning");
  else if (tone === "danger") node.classList.add("text-danger");
  else node.classList.add("text-muted");
}

/** Status next to Start button — must stay readable on white card (never text-white). */
function applyFormStatusTone(node, tone) {
  stripToneClasses(node);
  if (tone === "ok") {
    node.classList.add("text-success", "fw-semibold");
  } else if (tone === "warn") {
    node.classList.add("text-warning");
  } else if (tone === "danger") {
    node.classList.add("text-danger");
  } else {
    node.classList.add("text-muted");
  }
}

function updateGate(rowId, ok) {
  const row = el(rowId);
  if (!row) return;
  row.classList.toggle("cue-start-gate--ok", ok);
  row.classList.toggle("cue-start-gate--pending", !ok);
  const mark = row.querySelector(".cue-start-gate__mark");
  if (mark) mark.textContent = ok ? "✓" : "○";
}

export function syncReadinessUi() {
  const apiEl = el("apiStatus");
  const welcomeEl = el("welcomeApiStatus");
  const btn = el("btnBegin");
  const consentOk = Boolean(el("consent")?.checked);
  const nameOk = (el("candidateName")?.value || "").trim().length > 0;

  const serverOk =
    state.healthCheckComplete && !state.serverUnreachable && state.serverInterviewReady;
  const micOk = state.welcomeMicCheckPassed;

  updateGate("gateRowServer", serverOk);
  updateGate("gateRowMic", micOk);
  updateGate("gateRowName", nameOk);
  updateGate("gateRowConsent", consentOk);

  let heroText = "";
  let welcomeText = "";
  let tone = "muted";

  if (!state.healthCheckComplete) {
    heroText = "Checking server…";
    welcomeText = "Checking server…";
    tone = "muted";
  } else if (state.serverUnreachable) {
    heroText = "Server unreachable";
    welcomeText = "Server unreachable — fix connection";
    tone = "danger";
  } else if (!state.serverInterviewReady) {
    heroText = "Set OPENAI_API_KEY to continue";
    welcomeText = "API key missing on server";
    tone = "warn";
  } else if (!micOk) {
    heroText = "Test your microphone below";
    welcomeText = "Complete mic test (Record → Stop)";
    tone = "warn";
  } else if (!nameOk) {
    heroText = "Enter your name in the form →";
    welcomeText = "Enter your name";
    tone = "warn";
  } else if (!consentOk) {
    heroText = "Accept consent to start";
    welcomeText = "Tick the consent checkbox";
    tone = "warn";
  } else {
    heroText = "All set — tap Start";
    welcomeText = "Ready — tap Start voice interview";
    tone = "ok";
  }

  if (apiEl) {
    applyHeroTone(apiEl, tone);
    apiEl.textContent = heroText;
  }
  if (welcomeEl) {
    applyFormStatusTone(welcomeEl, tone);
    welcomeEl.textContent = welcomeText;
  }

  const canStart = serverOk && micOk && nameOk && consentOk;

  if (btn) {
    btn.disabled = !canStart;
    btn.classList.toggle("cue-btn--start-ready", canStart);
    btn.classList.toggle("cue-btn--start-locked", !canStart);
  }
}
