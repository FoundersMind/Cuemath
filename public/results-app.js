/**
 * Entry for standalone results page (/results.html).
 */
import { el } from "./js/dom.js";
import { state } from "./js/state.js";
import { initResultsPage } from "./js/assessment.js";
import { toast } from "./js/toast.js";

el("btnRestart")?.addEventListener("click", () => {
  window.location.href = "/";
});

el("btnDownloadPdf")?.addEventListener("click", () => {
  if (!state.sessionId) {
    toast("No session found to export yet.", { kind: "warning", title: "Nothing to export" });
    return;
  }
  const url = `/api/report/pdf?session_id=${encodeURIComponent(state.sessionId)}`;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
});

void initResultsPage();
