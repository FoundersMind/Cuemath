"""Delete sessions past retention_until (candidate PII, transcript, assessment)."""

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from api.models import InterviewSession


class Command(BaseCommand):
    help = "Remove interview sessions whose retention_until is in the past."

    def handle(self, *args, **options):
        now = timezone.now()
        qs = InterviewSession.objects.filter(retention_until__lt=now)
        count = qs.count()
        with transaction.atomic():
            qs.delete()
        self.stdout.write(self.style.SUCCESS(f"Deleted {count} expired session(s)."))
