/**
 * Lightweight toast notifications (Bootstrap-free).
 * Uses a single #toastRegion container injected into the DOM.
 */
const DEFAULT_DURATION_MS = 5000;
const MAX_TOASTS = 4;

function ensureRegion() {
  let host = document.getElementById("toastRegion");
  if (host) return host;
  host = document.createElement("div");
  host.id = "toastRegion";
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-relevant", "additions");
  document.body.appendChild(host);
  return host;
}

function iconFor(kind) {
  switch (kind) {
    case "success":
      return "✓";
    case "warning":
      return "!";
    case "danger":
      return "×";
    default:
      return "i";
  }
}

/**
 * Show a toast.
 * @param {string} message
 * @param {{title?: string, kind?: "info"|"success"|"warning"|"danger", durationMs?: number}} [opts]
 */
export function toast(message, opts = {}) {
  const host = ensureRegion();
  const { title, kind = "info", durationMs = DEFAULT_DURATION_MS } = opts;

  // Bound the stack size (avoid runaway if API is down).
  const existing = host.querySelectorAll(".cm-toast");
  if (existing.length >= MAX_TOASTS) existing[0]?.remove();

  const el = document.createElement("div");
  el.className = `cm-toast cm-toast--${kind}`;
  el.setAttribute("role", kind === "danger" ? "alert" : "status");

  const header = document.createElement("div");
  header.className = "cm-toast__header";

  const badge = document.createElement("span");
  badge.className = "cm-toast__icon";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = iconFor(kind);

  const h = document.createElement("div");
  h.className = "cm-toast__title";
  h.textContent = title || (kind === "danger" ? "Something went wrong" : "Heads up");

  const close = document.createElement("button");
  close.className = "cm-toast__close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "Close";

  header.appendChild(badge);
  header.appendChild(h);
  header.appendChild(close);

  const body = document.createElement("div");
  body.className = "cm-toast__body";
  body.textContent = message || "";

  el.appendChild(header);
  el.appendChild(body);
  host.appendChild(el);

  const cleanup = () => {
    el.classList.add("is-exiting");
    window.setTimeout(() => el.remove(), 180);
  };

  close.addEventListener("click", cleanup);
  if (durationMs > 0) window.setTimeout(cleanup, durationMs);
}

