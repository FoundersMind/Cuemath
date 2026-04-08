from __future__ import annotations

import uuid

from django.db import models


class InterviewSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    consent_at = models.DateTimeField(null=True, blank=True)
    consent_policy_version = models.CharField(max_length=32, default="2026-04-v1")
    candidate_email = models.EmailField(blank=True, default="")
    candidate_name = models.CharField(
        max_length=120,
        blank=True,
        default="",
        help_text="Preferred name for a natural greeting; not used every turn.",
    )
    client_ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=512, blank=True, default="")
    status = models.CharField(
        max_length=20,
        default="in_progress",
        choices=[
            ("in_progress", "In progress"),
            ("completed", "Completed"),
            ("abandoned", "Abandoned"),
        ],
    )
    retention_until = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Candidate PII / transcript should not be kept past this time (policy).",
    )
    openai_model = models.CharField(max_length=64, blank=True, default="")
    consecutive_bypass_turns = models.PositiveIntegerField(
        default=0,
        help_text="Server-side streak of skip/next-only candidate lines (enforced guardrail).",
    )
    consecutive_silent_turns = models.PositiveIntegerField(
        default=0,
        help_text="Streak of consecutive no-spoken-reply turns (client silence placeholder).",
    )
    closure_reason = models.CharField(
        max_length=32,
        blank=True,
        default="",
        help_text="How the screen ended: e.g. silent_no_response / bypass_guardrail if forced by platform.",
    )
    last_candidate_message_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Server-side throttle: last real candidate message accepted.",
    )
    candidate_rate_bucket_started_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Start of rolling 60s window for message burst limits.",
    )
    candidate_messages_in_rate_bucket = models.PositiveIntegerField(
        default=0,
        help_text="Real candidate messages counted in the current rolling window.",
    )

    # UI/progress metadata (soft guidance; not used for scoring directly).
    main_question_index = models.PositiveIntegerField(
        default=0,
        help_text="Count of distinct main screening questions asked so far (excludes follow-ups).",
    )
    target_questions = models.PositiveIntegerField(
        default=8,
        help_text="Soft target for number of main questions; can be adjusted dynamically.",
    )


class TranscriptLine(models.Model):
    session = models.ForeignKey(
        InterviewSession,
        on_delete=models.CASCADE,
        related_name="lines",
    )
    role = models.CharField(max_length=16)
    content = models.TextField()
    seq = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["seq", "id"]
        constraints = [
            models.UniqueConstraint(fields=["session", "seq"], name="api_transcriptline_session_seq_uniq"),
        ]


class AssessmentRecord(models.Model):
    session = models.OneToOneField(
        InterviewSession,
        on_delete=models.CASCADE,
        related_name="assessment",
    )
    payload = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)
