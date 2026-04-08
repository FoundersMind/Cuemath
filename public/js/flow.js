import { el } from "./dom.js";
import { state } from "./state.js";
import { releaseInterviewMicrophone } from "./recording.js";
import { finishAssessment } from "./assessment.js";

export function endInterviewFlow() {
  if (state.interviewEnded) return;
  releaseInterviewMicrophone();
  state.interviewEnded = true;
  state.interviewEndedAt = Date.now();
  el("phaseBadge").textContent = "Complete";
  el("phaseBadge").classList.replace("text-bg-secondary", "text-bg-success");
  el("btnMicStart").disabled = true;
  el("btnMicStop").disabled = true;
  finishAssessment();
}
