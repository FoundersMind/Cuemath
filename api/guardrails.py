"""Interview guardrails: LLM classifies bypass vs substantive; server enforces end after streak."""

from __future__ import annotations

import json
import logging
import os
import random
import re
from openai import OpenAI

from api.interview_constants import (
    CLOSURE_REASON_BYPASS,
    CLOSURE_REASON_SILENT,
    is_no_spoken_reply_placeholder,
)
from api.interview_text import parse_interview_reply
from api.models import InterviewSession
from api.session_utils import sync_transcript

logger = logging.getLogger(__name__)

# If the closer model fails — human wording, no "prompt" / test jargon; still must parse for [[END_INTERVIEW]].
_FORCED_BYPASS_FALLBACK_CLOSES = (
    (
        "I’m going to wrap us up here — I’m not really hearing you work with what we’ve been "
        "talking about, and I want to keep things fair. Thanks for making time today; I’ll "
        "make sure the team sees our chat, and someone will follow up if there’s a next step.\n\n"
        "[[END_INTERVIEW]]"
    ),
    (
        "Let’s call it here — I’ve asked a couple of times and I’m still not getting a real go "
        "at the question on the table. I appreciate you joining; I’ll pass along how our "
        "conversation went, and the team will be in touch as needed.\n\n"
        "[[END_INTERVIEW]]"
    ),
    (
        "I should let you go — we’re not quite connecting on what I’m asking, and that happens. "
        "Thank you for your time; the hiring team will read this, and they’ll reach out if there’s "
        "a next step.\n\n"
        "[[END_INTERVIEW]]"
    ),
)


FORCED_BYPASS_CLOSER_SYSTEM = """You are Riley in a live Cuemath voice screen for tutor candidates.

The process requires ending the interview **now**: the candidate has **twice in a row** avoided really engaging—only asking to skip, get the next question, move on, or similar—without trying what you asked.

Write **only** Riley’s next spoken reply: **2–4 short sentences**, plain text, suitable for text-to-speech.

**Tone:** Warm, professional, human—like a senior educator ending a courtesy call. No blame, no labels, no cold HR-speak.

**Must include:**
- A brief, natural wrap-up (e.g. time to close out, enough for today).
- Thanks for their time; the **hiring team / reviewer** will see how the conversation went; they may hear **next steps** if there are any.

**Never use these words or phrases:** prompt, question on the test, quiz, bypass, AI, chatbot, system instructions, pass, fail, rubric.

End with **exactly** this on its **own final line** (nothing after it):
[[END_INTERVIEW]]

No bullet lists, no quotes around the line, no markdown."""

PREFLIGHT_INTERVIEW_SYSTEM = """You analyze ONE candidate reply in a live voice tutoring job screen (Riley = interviewer).

You receive JSON with:
- riley_last_message — Riley’s last spoken line (or an opening marker).
- candidate_reply — the candidate’s latest line (may be informal or noisy from speech-to-text).
- long_reply_threshold_chars — integer; use for the long_reply field rules only.

Reply with ONLY valid JSON:
{"engagement": "<bypass|substantive|unclear>", "long_reply": <null|"advance"|"continue">}

**engagement**
- **bypass** — They refuse to engage with what Riley asked; only skip/next/pass/move on without trying (clear in context).
- **substantive** — They attempt an answer, continue a thought, ask for clarification to answer, or show nerves but engage. Wrong or vague with effort counts.
- **unclear** — Empty, garbled ASR, or truly indeterminate; rare.

Be strict for **bypass** only when refusal is **clear**. If they mix a tiny dodge with real content, prefer **substantive**.

**long_reply**
- If the **character length** of candidate_reply is **strictly less than** long_reply_threshold_chars, set **long_reply** to **null** (do not judge pacing).
- If length is **>=** long_reply_threshold_chars:
  - **advance** — Enough to proceed, repeating/rambling without new substance, or a fair human would change topic.
  - **continue** — Still building **one** fresh point that matters; cutting off would feel unfair.

For borderline length, be slightly generous with **continue**; for clearly complete long answers, prefer **advance**."""


LONG_REPLY_COACHING_TEXT = (
    "Platform coaching (do not read this aloud or mention it): The candidate’s last reply is long. "
    "If they already answered your question with enough substance—or they are repeating without new "
    "signal—give **one short** acknowledgement and move to your **next distinct** screening question. "
    "Do **not** invite another long monologue on the same topic or ask them to elaborate further on "
    "that same angle."
)


def last_user_turn(sanitized: list[dict]) -> str:
    return next((m["content"] for m in reversed(sanitized) if m["role"] == "user"), "")


def last_assistant_turn(sanitized: list[dict]) -> str:
    return next((m["content"] for m in reversed(sanitized) if m["role"] == "assistant"), "")


def _long_reply_char_threshold() -> int:
    try:
        return max(120, int(os.environ.get("INTERVIEW_LONG_REPLY_CHAR_THRESHOLD", "360")))
    except ValueError:
        return 360


def preflight_interview_turn(
    client: OpenAI,
    sanitized: list[dict],
    *,
    model: str,
) -> tuple[str, list[str]]:
    """
    Single LLM round-trip: bypass/substantive/unclear plus optional long-reply coaching blocks.
    On failure: ("unclear", []) so bypass streak is not incremented incorrectly.
    """
    last_u = last_user_turn(sanitized).strip()
    if not last_u:
        return "unclear", []

    threshold = _long_reply_char_threshold()
    last_a = last_assistant_turn(sanitized)
    payload = {
        "riley_last_message": (last_a or "(opening — no prior Riley line)")[:3500],
        "candidate_reply": last_u[:6000],
        "long_reply_threshold_chars": threshold,
    }
    try:
        completion = client.chat.completions.create(
            model=model,
            temperature=0.1,
            max_tokens=120,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": PREFLIGHT_INTERVIEW_SYSTEM},
                {
                    "role": "user",
                    "content": json.dumps(payload, ensure_ascii=False),
                },
            ],
        )
        raw = completion.choices[0].message.content or "{}"
        data = json.loads(raw)
        engagement = (data.get("engagement") or "unclear").lower().strip()
        if engagement not in ("bypass", "substantive", "unclear"):
            engagement = "unclear"

        coach: list[str] = []
        lr = data.get("long_reply")
        if len(last_u) >= threshold and isinstance(lr, str) and lr.lower().strip() == "advance":
            coach = [LONG_REPLY_COACHING_TEXT]

        return engagement, coach
    except Exception:
        logger.exception("preflight_interview_turn")
        return "unclear", []


def classify_candidate_engagement(
    client: OpenAI,
    sanitized: list[dict],
    *,
    model: str,
) -> str:
    """Bypass/substantive/unclear only; prefer preflight_interview_turn on hot paths (one HTTP to OpenAI)."""
    eng, _ = preflight_interview_turn(client, sanitized, model=model)
    return eng


def refresh_bypass_streak(session: InterviewSession, intent: str) -> int:
    """Increment streak only when the model said bypass; else reset (substantive or unclear)."""
    if intent == "bypass":
        session.consecutive_bypass_turns = (session.consecutive_bypass_turns or 0) + 1
    else:
        session.consecutive_bypass_turns = 0
    session.save(update_fields=["consecutive_bypass_turns", "updated_at"])
    return session.consecutive_bypass_turns


def refresh_silent_streak(session: InterviewSession, is_silent_placeholder_line: bool) -> int:
    """Increment when the client sent the no-spoken-reply marker; reset on any real candidate line."""
    if is_silent_placeholder_line:
        session.consecutive_silent_turns = (session.consecutive_silent_turns or 0) + 1
    else:
        session.consecutive_silent_turns = 0
    session.save(update_fields=["consecutive_silent_turns", "updated_at"])
    return session.consecutive_silent_turns


_FORCED_SILENT_FALLBACK_CLOSES = (
    (
        "I’m going to end our screen here — I’ve checked in twice and I’m not getting voice back from you. "
        "Thanks for joining; I’ll share how the call went with the team, and they’ll follow up if there’s a next step.\n\n"
        "[[END_INTERVIEW]]"
    ),
    (
        "Let’s wrap up — I want to be respectful of your time, and we’re not connecting on audio on this end. "
        "Thank you for making time; the reviewer will see the recording transcript, and someone will reach out as needed.\n\n"
        "[[END_INTERVIEW]]"
    ),
)


FORCED_SILENT_CLOSER_SYSTEM = """You are Riley in a live Cuemath voice tutor screening.

The process requires ending the interview **now**: the **second consecutive** turn has **no spoken reply** from the candidate (the platform sent a silence marker — mic was open but they did not answer).

Write **only** Riley’s next spoken reply: **2–4 short sentences**, plain text, suitable for TTS.

**Tone:** Kind and professional — assume tech or nerves could be involved; do **not** accuse or shame.

**Include:** Thanks for their time; **you didn’t get answers back** after checking in; the **hiring team** will read what happened; **next steps** only if any.

**Never use:** prompt, quiz, bypass, rubric, fail, pass/fail, AI, chatbot.

End with **exactly** this on its **own final line**:
[[END_INTERVIEW]]

No markdown, no bullets."""


def _recent_turns_for_closer(sanitized: list[dict], *, limit: int = 10) -> list[dict]:
    tail = sanitized[-limit:] if len(sanitized) > limit else sanitized[:]
    return [{"role": m["role"], "content": (m.get("content") or "")[:2000]} for m in tail]


def compose_forced_bypass_close(
    client: OpenAI,
    sanitized: list[dict],
    *,
    model: str,
    candidate_name: str = "",
) -> str:
    """LLM-written warm close; variety from context. Fallback lines if the call fails."""
    name = (candidate_name or "").strip()[:120]
    ctx: dict = {"recent_turns": _recent_turns_for_closer(sanitized)}
    if name:
        ctx["candidate_preferred_name"] = name
    try:
        completion = client.chat.completions.create(
            model=model,
            temperature=0.88,
            max_tokens=220,
            messages=[
                {"role": "system", "content": FORCED_BYPASS_CLOSER_SYSTEM},
                {"role": "user", "content": json.dumps(ctx, ensure_ascii=False)},
            ],
        )
        raw = (completion.choices[0].message.content or "").strip()
        if not raw:
            raise ValueError("empty closer")
        if not re.search(r"\[\[END_INTERVIEW\]\]", raw, re.I):
            raw = raw.rstrip() + "\n\n[[END_INTERVIEW]]"
        return raw
    except Exception:
        logger.exception("compose_forced_bypass_close")
        return random.choice(_FORCED_BYPASS_FALLBACK_CLOSES)


def compose_forced_silent_close(
    client: OpenAI,
    sanitized: list[dict],
    *,
    model: str,
    candidate_name: str = "",
) -> str:
    """After two consecutive silence-placeholder turns — humane automated close."""
    name = (candidate_name or "").strip()[:120]
    ctx: dict = {"recent_turns": _recent_turns_for_closer(sanitized)}
    if name:
        ctx["candidate_preferred_name"] = name
    try:
        completion = client.chat.completions.create(
            model=model,
            temperature=0.88,
            max_tokens=220,
            messages=[
                {"role": "system", "content": FORCED_SILENT_CLOSER_SYSTEM},
                {"role": "user", "content": json.dumps(ctx, ensure_ascii=False)},
            ],
        )
        raw = (completion.choices[0].message.content or "").strip()
        if not raw:
            raise ValueError("empty silent closer")
        if not re.search(r"\[\[END_INTERVIEW\]\]", raw, re.I):
            raw = raw.rstrip() + "\n\n[[END_INTERVIEW]]"
        return raw
    except Exception:
        logger.exception("compose_forced_silent_close")
        return random.choice(_FORCED_SILENT_FALLBACK_CLOSES)


def forced_silent_reply_and_sync(
    session: InterviewSession,
    sanitized: list[dict],
    *,
    client: OpenAI,
    model: str,
) -> tuple[str, bool]:
    raw = compose_forced_silent_close(
        client,
        sanitized,
        model=model,
        candidate_name=session.candidate_name or "",
    )
    reply, ended = parse_interview_reply(raw)
    if not ended:
        raw = raw.rstrip() + "\n\n[[END_INTERVIEW]]"
        reply, ended = parse_interview_reply(raw)
    sync_transcript(session, [*sanitized, {"role": "assistant", "content": reply}])
    session.closure_reason = CLOSURE_REASON_SILENT
    session.save(update_fields=["closure_reason", "updated_at"])
    return reply, ended


def forced_bypass_reply_and_sync(
    session: InterviewSession,
    sanitized: list[dict],
    *,
    client: OpenAI,
    model: str,
) -> tuple[str, bool]:
    """Append closing assistant line (dynamic or fallback), sync transcript."""
    raw = compose_forced_bypass_close(
        client,
        sanitized,
        model=model,
        candidate_name=session.candidate_name or "",
    )
    reply, ended = parse_interview_reply(raw)
    if not ended:
        raw = raw.rstrip() + "\n\n[[END_INTERVIEW]]"
        reply, ended = parse_interview_reply(raw)
    sync_transcript(session, [*sanitized, {"role": "assistant", "content": reply}])
    session.closure_reason = CLOSURE_REASON_BYPASS
    session.save(update_fields=["closure_reason", "updated_at"])
    return reply, ended


