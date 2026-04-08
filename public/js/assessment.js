import { el, escapeHtml } from "./dom.js";
import { state } from "./state.js";
import { postJson } from "./api.js";

/** Written on index when interview ends; read on /results.html. */
export const ASSESS_PENDING_KEY = "cue_assess_pending";
/** Cached last successful report (same-tab refresh). Cleared when a new interview starts. */
export const ASSESS_SNAPSHOT_KEY = "cue_last_assessment_view";

function fmtDurationMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function transcriptForAssess() {
  return state.messages
    .map((m) => `${m.role === "assistant" ? "Interviewer" : "Candidate"}: ${m.content}`)
    .join("\n\n");
}

export async function finishAssessment() {
  if (state.assessmentInFlight) return;
  state.assessmentInFlight = true;
  const nameField = typeof document !== "undefined" ? document.getElementById("candidateName") : null;
  const pending = {
    sessionId: state.sessionId,
    transcript: transcriptForAssess(),
    candidateName: (nameField?.value || "").trim() || state.candidateName || "",
    interviewStartedAt: state.interviewStartedAt,
    interviewEndedAt: state.interviewEndedAt,
  };
  try {
    sessionStorage.setItem(ASSESS_PENDING_KEY, JSON.stringify(pending));
  } catch {
    // If storage fails, still navigate; results page will show an error state.
  }
  window.location.href = "/results.html";
}

function applyPendingToState(pending) {
  state.sessionId = pending.sessionId;
  state.candidateName = pending.candidateName || "";
  state.interviewStartedAt = pending.interviewStartedAt ?? null;
  state.interviewEndedAt = pending.interviewEndedAt ?? null;
}

/**
 * Boot the standalone results page: run assess from sessionStorage, or restore last snapshot (refresh).
 */
export async function initResultsPage() {
  const busy = el("assessBusy");
  const content = el("resultsContent");
  const errEl = el("resultsError");

  let pendingRaw = null;
  try {
    pendingRaw = sessionStorage.getItem(ASSESS_PENDING_KEY);
  } catch {
    /* ignore */
  }

  if (!pendingRaw) {
    let snapRaw = null;
    try {
      snapRaw = sessionStorage.getItem(ASSESS_SNAPSHOT_KEY);
    } catch {
      /* ignore */
    }
    if (snapRaw) {
      try {
        const snap = JSON.parse(snapRaw);
        applyPendingToState(snap);
        if (busy) busy.classList.add("d-none");
        if (errEl) errEl.classList.add("d-none");
        renderAssessment(snap.assessment);
        if (content) content.classList.remove("d-none");
        return;
      } catch {
        try {
          sessionStorage.removeItem(ASSESS_SNAPSHOT_KEY);
        } catch {
          /* ignore */
        }
      }
    }
    if (busy) busy.classList.add("d-none");
    if (content) content.classList.add("d-none");
    if (errEl) {
      errEl.textContent =
        "No report data found. Start an interview from the home page, or use the same browser tab session.";
      errEl.classList.remove("d-none");
    }
    return;
  }

  let pending;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    if (busy) busy.classList.add("d-none");
    if (errEl) {
      errEl.textContent = "Invalid saved session data.";
      errEl.classList.remove("d-none");
    }
    return;
  }

  if (!pending.sessionId || !(typeof pending.transcript === "string" && pending.transcript.trim())) {
    if (busy) busy.classList.add("d-none");
    if (errEl) {
      errEl.textContent = "Missing session or transcript.";
      errEl.classList.remove("d-none");
    }
    return;
  }

  applyPendingToState(pending);
  if (busy) busy.classList.remove("d-none");
  if (content) content.classList.add("d-none");
  if (errEl) errEl.classList.add("d-none");

  try {
    const { assessment } = await postJson("/api/interview/assess", {
      session_id: pending.sessionId,
      transcript: pending.transcript,
    });
    renderAssessment(assessment);
    try {
      sessionStorage.setItem(
        ASSESS_SNAPSHOT_KEY,
        JSON.stringify({
          sessionId: pending.sessionId,
          assessment,
          candidateName: pending.candidateName || "",
          interviewStartedAt: pending.interviewStartedAt,
          interviewEndedAt: pending.interviewEndedAt,
        }),
      );
      sessionStorage.removeItem(ASSESS_PENDING_KEY);
    } catch {
      /* ignore */
    }
    if (busy) busy.classList.add("d-none");
    if (content) content.classList.remove("d-none");
  } catch (e) {
    if (busy) busy.classList.add("d-none");
    if (errEl) {
      errEl.textContent = e?.message || "Assessment failed.";
      errEl.classList.remove("d-none");
    }
  }
}

export function renderAssessment(a) {
  el("summaryText").textContent = a.summary || "";

  const nameEl = el("resultsCandidateName");
  if (nameEl) nameEl.textContent = state?.candidateName || state?.sessionCandidateName || nameEl.textContent;
  // Prefer name from input if available (safe to read; already on page).
  const inputName = document.getElementById("candidateName")?.value?.trim();
  if (nameEl && inputName) nameEl.textContent = inputName;

  const metaEl = el("resultsMeta");
  if (metaEl) {
    const durMs =
      state.interviewStartedAt && state.interviewEndedAt
        ? state.interviewEndedAt - state.interviewStartedAt
        : null;
    const dur = durMs == null ? "—" : fmtDurationMs(durMs);
    const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
    metaEl.textContent = `${date} · ${dur}`;
  }

  const rec = a.recommendation || "maybe";
  const badge = el("recBadge");
  badge.textContent = rec.replaceAll("_", " ");
  badge.className = "badge fs-6 rounded-pill ";
  if (rec === "advance") badge.classList.add("text-bg-success");
  else if (rec === "no_advance") badge.classList.add("text-bg-danger");
  else badge.classList.add("text-bg-warning", "text-dark");

  const dims = a.dimensions || {};
  // Compute an overall score out of 100 from dimension scores (0–5 each).
  const scores = Object.values(dims)
    .map((d) => Number(d?.score))
    .filter((n) => Number.isFinite(n));
  const avg5 = scores.length ? scores.reduce((s, n) => s + n, 0) / scores.length : null;
  const overall = avg5 == null ? null : Math.round((avg5 / 5) * 100);
  const overallEl = el("overallScore");
  if (overallEl) overallEl.textContent = overall == null ? "—" : String(overall);

  const grid = el("dimensionsGrid");
  grid.innerHTML = "";
  const order = ["clarity", "warmth", "simplicity", "patience", "fluency"];
  order.forEach((key) => {
    const d = dims[key];
    if (!d) return;
    const col = document.createElement("div");
    col.className = "col-12 col-sm-6 col-xl-4";
    col.innerHTML = `
      <div class="cue-dim card h-100">
        <div class="card-body">
          <div class="cue-dim__top">
            <h3 class="cue-dim__title">${escapeHtml(key)}</h3>
            <span class="cue-dim__score">${Number(d.score) || 0}/5</span>
          </div>
          <div class="cue-dim__bar" aria-hidden="true">
            <span class="cue-dim__fill" style="width:${Math.max(0, Math.min(100, (Number(d.score) / 5) * 100))}%"></span>
          </div>
          <p class="cue-dim__comment">${escapeHtml(d.comment || "")}</p>
          ${(d.evidence || []).length
            ? `<details class="cue-dim__evidence">
                <summary>Evidence quotes</summary>
                <div class="cue-dim__quotes">${(d.evidence || []).map((q) => `<q>${escapeHtml(q)}</q>`).join("<br/>")}</div>
              </details>`
            : ""}
        </div>
      </div>`;
    grid.appendChild(col);
  });

  const fillList = (id, items) => {
    const ul = el(id);
    ul.innerHTML = "";
    (items || []).forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    });
  };
  fillList("strengthsList", a.strengths);
  fillList("risksList", a.risks);

  const fu = a.follow_up_questions || [];
  if (fu.length) {
    el("followupCard").classList.remove("d-none");
    fillList("followupList", fu);
  } else {
    el("followupCard").classList.add("d-none");
  }

  const hns = a.hiring_next_step || {};
  const needOutreach =
    hns.type === "contact_candidate_verify_interest" &&
    (String(hns.guidance_for_panel || "").trim().length > 0);
  const hnCard = el("hiringNextStepCard");
  const hnText = el("hiringNextStepText");
  if (needOutreach && hnCard && hnText) {
    hnCard.classList.remove("d-none");
    hnText.textContent = hns.guidance_for_panel;
  } else if (hnCard) {
    hnCard.classList.add("d-none");
  }
}
