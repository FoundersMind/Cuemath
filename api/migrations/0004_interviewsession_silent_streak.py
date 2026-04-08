from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0003_interviewsession_candidate_name"),
    ]

    operations = [
        migrations.AddField(
            model_name="interviewsession",
            name="consecutive_silent_turns",
            field=models.PositiveIntegerField(
                default=0,
                help_text="Server-side streak of consecutive no-spoken-reply turns (platform placeholder lines).",
            ),
        ),
    ]
