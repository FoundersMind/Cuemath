from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0004_interviewsession_silent_streak"),
    ]

    operations = [
        migrations.AddField(
            model_name="interviewsession",
            name="closure_reason",
            field=models.CharField(
                blank=True,
                default="",
                help_text="How the screen ended: e.g. silent_no_response / bypass_guardrail if forced by platform.",
                max_length=32,
            ),
        ),
    ]
