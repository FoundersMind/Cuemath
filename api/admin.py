from django.contrib import admin

from api.models import AssessmentRecord, InterviewSession, TranscriptLine


class TranscriptLineInline(admin.TabularInline):
    model = TranscriptLine
    extra = 0
    readonly_fields = ("created_at",)
    ordering = ("seq",)


@admin.register(InterviewSession)
class InterviewSessionAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "status",
        "closure_reason",
        "candidate_name",
        "candidate_email",
        "consent_at",
        "created_at",
        "retention_until",
    )
    list_filter = ("status",)
    search_fields = ("candidate_name", "candidate_email", "id")
    inlines = [TranscriptLineInline]
    readonly_fields = ("id", "created_at", "updated_at")


@admin.register(AssessmentRecord)
class AssessmentRecordAdmin(admin.ModelAdmin):
    list_display = ("session", "created_at")
    readonly_fields = ("created_at",)
