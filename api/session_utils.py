from __future__ import annotations

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone

from api.models import InterviewSession, TranscriptLine


def get_session_for_api(session_id: str) -> InterviewSession:
    return get_object_or_404(InterviewSession, pk=session_id)


def sync_transcript(session: InterviewSession, messages: list[dict]) -> None:
    """Idempotent ordered transcript: one delete + bulk_insert (fast vs per-row upserts)."""
    rows = [
        TranscriptLine(
            session=session,
            seq=i,
            role=m["role"],
            content=(m.get("content") or "")[:500_000],
        )
        for i, m in enumerate(messages)
    ]
    with transaction.atomic():
        TranscriptLine.objects.filter(session=session).delete()
        if rows:
            TranscriptLine.objects.bulk_create(rows)


def transcript_plain(session: InterviewSession) -> str:
    lines = []
    for row in session.lines.order_by("seq", "id"):
        label = "Interviewer" if row.role == "assistant" else "Candidate"
        lines.append(f"{label}: {row.content}")
    return "\n\n".join(lines)


def mark_completed(session: InterviewSession) -> None:
    session.status = "completed"
    session.save(update_fields=["status", "updated_at"])


def is_past_retention(session: InterviewSession) -> bool:
    if session.retention_until is None:
        return False
    return timezone.now() > session.retention_until
