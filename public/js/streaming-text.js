import { STREAMING_TEXT_CHARS_PER_SEC } from "./config.js";
import { el } from "./dom.js";

function cleanInterviewerDisplay(s) {
  return s.replace(/\[\[END_INTERVIEW\]\]/gi, "").trim();
}

/**
 * Reveals interviewer SSE text at a **constant** rate (chars/sec) so speed doesn’t surge when the
 * model is ahead of the buffer — easier to follow with TTS. Clauses may still jump ahead for speech sync.
 */
export function createInterviewerStreamDisplay() {
  let targetRaw = "";
  let visibleCount = 0;
  let rafId = null;
  let lastTime = 0;
  /** Fractional chars so rates below ~60/s work (no forced min 1 char/frame). */
  let charCarry = 0;
  /** Resolvers waiting for reveal to reach current target length. */
  const idleWaiters = [];

  function targetClean() {
    return cleanInterviewerDisplay(targetRaw);
  }

  function notifyIdleIfCaughtUp() {
    const full = targetClean();
    if (visibleCount < full.length) return;
    while (idleWaiters.length) {
      const r = idleWaiters.shift();
      r();
    }
  }

  function tick(now) {
    const node = el("interviewerText");
    const bubble = el("interviewerBubble");
    if (!node) {
      rafId = null;
      if (bubble) bubble.classList.remove("is-streaming");
      return;
    }

    const full = targetClean();
    const len = full.length;

    if (!lastTime) lastTime = now;
    const dt = Math.min(0.048, (now - lastTime) / 1000);
    lastTime = now;

    if (visibleCount >= len) {
      rafId = null;
      if (bubble) bubble.classList.remove("is-streaming");
      notifyIdleIfCaughtUp();
      return;
    }

    charCarry += STREAMING_TEXT_CHARS_PER_SEC * dt;
    const step = Math.floor(charCarry);
    charCarry -= step;
    visibleCount = Math.min(len, visibleCount + step);

    node.textContent = full.slice(0, visibleCount);
    if (bubble) bubble.classList.add("is-streaming");

    if (visibleCount < len) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = null;
      if (bubble) bubble.classList.remove("is-streaming");
      notifyIdleIfCaughtUp();
    }
  }

  function schedule() {
    if (rafId == null) rafId = requestAnimationFrame(tick);
  }

  return {
    appendDelta(delta) {
      targetRaw += delta;
      schedule();
    },

    /**
     * Lock display target to the final parsed reply and continue revealing smoothly until caught up.
     */
    finishToTarget(reply) {
      targetRaw = reply;
      const full = targetClean();
      if (visibleCount > full.length) visibleCount = full.length;
      schedule();
    },

    /**
     * Ensure at least this clause is visible (for sync: call right before playing TTS for the same clause).
     * Keeps animating toward the rest of `targetRaw` afterward.
     */
    revealThroughClause(clauseText) {
      const fragment = clauseText.replace(/\[\[END_INTERVIEW\]\]/gi, "").trim();
      if (!fragment) return;
      const full = targetClean();
      let idx = full.indexOf(fragment);
      let span = fragment.length;
      if (idx === -1) {
        try {
          const esc = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const flex = esc.replace(/\s+/g, "\\s+");
          const m = full.match(new RegExp(flex));
          if (m && m.index !== undefined) {
            idx = m.index;
            span = m[0].length;
          }
        } catch {
          /* ignore */
        }
      }
      if (idx === -1) return;
      const end = Math.min(full.length, idx + span);
      visibleCount = Math.max(visibleCount, end);
      const node = el("interviewerText");
      const bubble = el("interviewerBubble");
      if (node) node.textContent = full.slice(0, visibleCount);
      if (bubble) {
        if (visibleCount < full.length) bubble.classList.add("is-streaming");
        else bubble.classList.remove("is-streaming");
      }
      schedule();
    },

    /** Resolves when visible text has caught up to the current target (including after finishToTarget). */
    whenIdle() {
      const full = targetClean();
      if (visibleCount >= full.length) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    cancel() {
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastTime = 0;
      charCarry = 0;
      idleWaiters.length = 0;
      const bubble = el("interviewerBubble");
      if (bubble) bubble.classList.remove("is-streaming");
    },
  };
}
