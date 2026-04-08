# Cuemath Tutor Screener

AI-assisted **voice interview** for tutor screening: candidates talk with an interviewer (“Riley”), answers are transcribed and scored; recruiters review sessions in a small Django-backed UI.

## Stack

- **Backend:** Django 5, `django.contrib.auth` (recruiter login), SQLite (local) or PostgreSQL via `DATABASE_URL`
- **Candidate UI:** Static HTML/CSS/JS in `public/` (ES modules), served by Django
- **AI:** OpenAI (chat, transcription, TTS) — see `.env.example`
- **Production:** Gunicorn, WhiteNoise for static files; `Procfile` included for Railway-style hosts

## Local setup

1. **Python 3.11+** recommended.

2. Create a virtualenv, install dependencies:

   ```bash
   cd tutor-screener
   python -m venv .venv
   .venv\Scripts\activate   # Windows
   # source .venv/bin/activate   # macOS/Linux
   pip install -r requirements.txt
   ```

3. **Environment:** copy `.env.example` to `.env` and set at least:

   - `OPENAI_API_KEY`
   - `DJANGO_SECRET_KEY` (any random string for dev)

4. **Database & run:**

   ```bash
   python manage.py migrate
   python manage.py createsuperuser   # for /recruiter/ login and /admin/
   python manage.py runserver
   ```

5. Open **http://127.0.0.1:8000/** for the candidate flow.

## URLs

| Path | Purpose |
|------|--------|
| `/` | Candidate landing + interview (`public/index.html`) |
| `/results.html` | Post-interview assessment view (after redirect from app) |
| `/recruiter/` | Recruiter dashboard (login required) |
| `/admin/` | Django admin |
| `/api/*` | JSON API (health, session, interview stream, transcribe, TTS, assess, etc.) |

## Production (e.g. Railway)

1. Connect the repo; ensure the service root is this folder (where `manage.py` and `Procfile` live).

2. Set environment variables (minimum):

   - `OPENAI_API_KEY`
   - `DJANGO_SECRET_KEY`
   - `DJANGO_DEBUG=0`
   - `DATABASE_URL` if using Railway PostgreSQL
   - Optionally `DJANGO_ALLOWED_HOSTS` for custom domains (default Railway `*.up.railway.app` hosts are allowed in settings)

3. Deploy uses the **Procfile**: migrate → `collectstatic` → Gunicorn on `$PORT`.

## Project layout (short)

- `api/` — models, interview views, streaming, assessment, recruiter views
- `cuemath_screener/` — Django settings, URLs, WSGI
- `public/` — candidate SPA-style assets (`app.js`, `js/`, `styles.css`)
- `templates/` — recruiter (and shared) HTML

## License / ownership

Use and deployment terms are up to the project owner (FoundersMind / Cuemath hiring context).
