"""Shared text utilities for interview assistant replies."""

from __future__ import annotations

import re


def parse_interview_reply(raw: str) -> tuple[str, bool]:
    reply, ended, _is_main = parse_interview_reply_flags(raw)
    return reply, ended


def parse_interview_reply_flags(raw: str) -> tuple[str, bool, bool]:
    """Parse assistant reply and strip platform markers.

    Markers:
    - [[END_INTERVIEW]]: end the interview now
    - [[MAIN_QUESTION]]: assistant asked a new distinct main screening question (not a follow-up)
    """
    ended = bool(re.search(r"\[\[END_INTERVIEW\]\]", raw, re.I))
    is_main = bool(re.search(r"\[\[MAIN_QUESTION\]\]", raw, re.I))
    reply = re.sub(r"\[\[END_INTERVIEW\]\]", "", raw, flags=re.I)
    reply = re.sub(r"\[\[MAIN_QUESTION\]\]", "", reply, flags=re.I)
    reply = " ".join(reply.split()).strip()
    return reply, ended, is_main
