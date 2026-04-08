import { el } from "./dom.js";
import { state } from "./state.js";
import { syncReadinessUi } from "./readiness.js";

export async function health() {
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    state.healthCheckComplete = true;
    state.serverUnreachable = false;
    state.serverInterviewReady = Boolean(j.openai);
  } catch {
    state.healthCheckComplete = true;
    state.serverUnreachable = true;
    state.serverInterviewReady = false;
  }
  syncReadinessUi();
}

export async function ensureSession() {
  if (state.sessionId) return;
  const nameField = el("candidateName");
  const candidate_name = (nameField?.value || "").trim();
  if (!candidate_name) throw new Error("Name is required to start");
  const emailField = el("candidateEmail");
  const candidate_email = emailField ? emailField.value.trim() : "";
  const r = await fetch("/api/session/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consent: true,
      policy_version: "2026-04-v1",
      candidate_name,
      candidate_email: candidate_email || undefined,
      retention_days: 90,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  state.sessionId = j.session_id;
}

export async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
