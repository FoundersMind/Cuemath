from __future__ import annotations

import json

from django.contrib.auth.decorators import user_passes_test
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404, render

from api.models import AssessmentRecord, InterviewSession
from api.session_utils import transcript_plain


def _staff(u):
    return u.is_authenticated and u.is_staff


@user_passes_test(_staff)
def dashboard(request: HttpRequest) -> HttpResponse:
    sessions = InterviewSession.objects.order_by("-created_at")[:200]
    return render(
        request,
        "recruiter/dashboard.html",
        {"sessions": sessions},
    )


@user_passes_test(_staff)
def session_detail(request: HttpRequest, pk) -> HttpResponse:
    session = get_object_or_404(InterviewSession, pk=pk)
    transcript = transcript_plain(session)
    assessment = AssessmentRecord.objects.filter(session=session).first()
    assessment_json = json.dumps(assessment.payload, indent=2) if assessment else ""
    return render(
        request,
        "recruiter/session_detail.html",
        {
            "session": session,
            "transcript": transcript,
            "assessment": assessment,
            "assessment_json": assessment_json,
        },
    )
