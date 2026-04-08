"""Shared interview strings — keep in sync with public/js/config.js (NO_CANDIDATE_REPLY_PLACEHOLDER)."""

from __future__ import annotations

# Marker sent by the client when the mic had no usable speech for that turn.
NO_SPOKEN_REPLY_PLACEHOLDER = "[No spoken reply from the candidate on this turn.]"

# Persisted on InterviewSession.closure_reason when the platform forces an end.
CLOSURE_REASON_SILENT = "silent_no_response"
CLOSURE_REASON_BYPASS = "bypass_guardrail"


def is_no_spoken_reply_placeholder(text: str) -> bool:
    return bool(text and text.strip() == NO_SPOKEN_REPLY_PLACEHOLDER.strip())
