/**
 * Candidate interview hardening (best-effort, client-side only).
 * Deters copy/paste, selection, and common shortcuts while the interview screen is active.
 */
import { toast } from "./toast.js";

let teardown = null;
let blurWarned = false;

function preventClipboard(e) {
  e.preventDefault();
  if (e.clipboardData) {
    try {
      e.clipboardData.setData("text/plain", "");
    } catch {
      /* ignore */
    }
  }
}

function onKeyDown(e) {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) {
    if (e.key === "F12") e.preventDefault();
    return;
  }
  const k = (e.key || "").toLowerCase();
  // Copy, paste, cut, select-all, save, print; devtools shortcuts (best-effort).
  if (["c", "v", "x", "a", "s", "p", "u"].includes(k)) {
    e.preventDefault();
  }
  if (e.shiftKey && ["i", "j", "c", "k"].includes(k)) {
    e.preventDefault();
  }
}

function onContextMenu(e) {
  e.preventDefault();
}

function onDragStart(e) {
  e.preventDefault();
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden" && !blurWarned) {
    blurWarned = true;
    toast("Please keep this tab in focus until you finish the interview.", {
      kind: "warning",
      title: "Tab in background",
    });
  }
}

/** Enable or disable guards (call from screen transitions). */
export function setInterviewGuardsActive(active) {
  if (teardown) {
    teardown();
    teardown = null;
  }
  if (!active) {
    blurWarned = false;
    return;
  }
  blurWarned = false;

  const opts = { capture: true };
  document.addEventListener("copy", preventClipboard, opts);
  document.addEventListener("cut", preventClipboard, opts);
  document.addEventListener("paste", preventClipboard, opts);
  document.addEventListener("keydown", onKeyDown, opts);
  document.addEventListener("contextmenu", onContextMenu, opts);
  document.addEventListener("dragstart", onDragStart, opts);
  document.addEventListener("visibilitychange", onVisibilityChange);

  teardown = () => {
    document.removeEventListener("copy", preventClipboard, opts);
    document.removeEventListener("cut", preventClipboard, opts);
    document.removeEventListener("paste", preventClipboard, opts);
    document.removeEventListener("keydown", onKeyDown, opts);
    document.removeEventListener("contextmenu", onContextMenu, opts);
    document.removeEventListener("dragstart", onDragStart, opts);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
