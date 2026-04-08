from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0005_interviewsession_closure_reason"),
    ]

    operations = [
        migrations.AddField(
            model_name="interviewsession",
            name="last_candidate_message_at",
            field=models.DateTimeField(
                blank=True,
                help_text="Server-side throttle: last real candidate message accepted.",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="interviewsession",
            name="candidate_rate_bucket_started_at",
            field=models.DateTimeField(
                blank=True,
                help_text="Start of rolling 60s window for message burst limits.",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="interviewsession",
            name="candidate_messages_in_rate_bucket",
            field=models.PositiveIntegerField(
                default=0,
                help_text="Real candidate messages counted in the current rolling window.",
            ),
        ),
    ]
