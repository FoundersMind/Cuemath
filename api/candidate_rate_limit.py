"""Per-session rate limits for candidate interview turns (anti-spam / flow abuse)."""

from __future__ import annotations

import os
from typing import Tuple

from django.db import transaction
from django.utils import timezone

from api.models import InterviewSession


def _min_interval_sec() -> float:
    try:
        return max(0.0, float(os.environ.get("INTERVIEW_CANDIDATE_MIN_MESSAGE_INTERVAL_SEC", "1.0")))
    except ValueError:
        return 1.0


def _max_messages_per_minute() -> int:
    try:
        return max(1, int(os.environ.get("INTERVIEW_CANDIDATE_MAX_MESSAGES_PER_MINUTE", "18")))
    except ValueError:
        return 18


def _max_candidate_turn_chars() -> int:
    try:
        return max(2000, int(os.environ.get("INTERVIEW_MAX_CANDIDATE_TURN_CHARS", "10000")))
    except ValueError:
        return 10_000


def candidate_turn_too_long(text: str) -> bool:
    return len((text or "").strip()) > _max_candidate_turn_chars()


@transaction.atomic
def check_and_record_candidate_message_rate(session: InterviewSession) -> Tuple[bool, str | None]:
    """
    Enforce minimum spacing and max messages per rolling minute for real candidate lines.
    On success, updates session and returns (True, None).
    """
    locked = InterviewSession.objects.select_for_update().get(pk=session.pk)
    now = timezone.now()
    min_gap = _min_interval_sec()
    if locked.last_candidate_message_at is not None and min_gap > 0:
        delta = (now - locked.last_candidate_message_at).total_seconds()
        if delta < min_gap:
            return False, "Please wait a moment before sending another answer."

    window_start = locked.candidate_rate_bucket_started_at
    in_bucket = locked.candidate_messages_in_rate_bucket or 0
    if window_start is None or (now - window_start).total_seconds() > 60:
        locked.candidate_rate_bucket_started_at = now
        locked.candidate_messages_in_rate_bucket = 1
    else:
        nxt = in_bucket + 1
        if nxt > _max_messages_per_minute():
            return (
                False,
                "That’s a lot of answers in a short time — take a brief pause so we can keep the interview fair.",
            )
        locked.candidate_messages_in_rate_bucket = nxt

    locked.last_candidate_message_at = now
    locked.save(
        update_fields=[
            "last_candidate_message_at",
            "candidate_rate_bucket_started_at",
            "candidate_messages_in_rate_bucket",
            "updated_at",
        ],
    )
    return True, None
