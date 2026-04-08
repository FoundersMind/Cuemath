from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0002_interviewsession_bypass_streak"),
    ]

    operations = [
        migrations.AddField(
            model_name="interviewsession",
            name="candidate_name",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Preferred name for a natural greeting; not used every turn.",
                max_length=120,
            ),
        ),
    ]
