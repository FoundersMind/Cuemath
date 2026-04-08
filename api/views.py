from __future__ import annotations

import io
import json
import logging
import mimetypes
import os
import re
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.core.exceptions import SuspiciousOperation
from django.http import FileResponse, HttpResponse, JsonResponse, StreamingHttpResponse
from django.utils import timezone
from django.utils._os import safe_join
from django.views.decorators.csrf import csrf_exempt
from openai import OpenAI

from api.candidate_rate_limit import (
    candidate_turn_too_long,
    check_and_record_candidate_message_rate,
)
from api.guardrails import (
    forced_bypass_reply_and_sync,
    forced_silent_reply_and_sync,
    is_no_spoken_reply_placeholder,
    last_user_turn,
    preflight_interview_turn,
    refresh_bypass_streak,
    refresh_silent_streak,
)
from api.interview_text import parse_interview_reply, parse_interview_reply_flags
from api.models import AssessmentRecord, InterviewSession
from api.interview_constants import CLOSURE_REASON_SILENT
from api.prompts import ASSESSOR_SYSTEM, interviewer_system_for_session, start_user_message
from api.session_utils import (
    is_past_retention,
    mark_completed,
    sync_transcript,
    transcript_plain,
)

logger = logging.getLogger(__name__)

PUBLIC_ROOT = Path(settings.BASE_DIR) / "public"

OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
TRANSCRIBE_MODEL = os.environ.get("OPENAI_TRANSCRIBE_MODEL", "whisper-1")
OPENAI_TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "tts-1")
OPENAI_TTS_VOICE = os.environ.get("OPENAI_TTS_VOICE", "nova")
MAX_TTS_CHARS = 4096


def _interview_max_tokens() -> int:
    """Cap reply length for lower latency (voice lines should stay short)."""
    raw = os.environ.get("OPENAI_INTERVIEW_MAX_TOKENS", "320")
    try:
        return max(120, min(600, int(raw)))
    except ValueError:
        return 320


def _client():
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return None
    return OpenAI(api_key=key)


def _json_error(message: str, status: int = 400):
    return JsonResponse({"error": message}, status=status)


def _sse_event(data: dict) -> bytes:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def _pop_tts_sentences(buffer: str) -> tuple[list[str], str]:
    """Split complete sentences for early TTS while the model stream is still open."""
    sentences: list[str] = []
    rest = buffer
    while len(rest) >= 8:
        m = re.search(r"[.!?](?:\s+|$)", rest)
        if not m:
            break
        end = m.end()
        frag = rest[:end].strip()
        rest = rest[end:].lstrip()
        frag = re.sub(r"\[\[END_INTERVIEW\]\]\s*", "", frag, flags=re.I).strip()
        frag = re.sub(r"\[\[MAIN_QUESTION\]\]\s*", "", frag, flags=re.I).strip()
        if len(frag) >= 3:
            sentences.append(frag)
    return sentences, rest


def _interview_messages_for_model(
    sys_prompt: str,
    sanitized: list[dict],
    extra_system_instructions: list[str] | None = None,
) -> list[dict]:
    out: list[dict] = [{"role": "system", "content": sys_prompt}]
    for block in extra_system_instructions or []:
        b = (block or "").strip()
        if b:
            out.append({"role": "system", "content": b})
    out.extend(sanitized)
    return out


def _stream_interview_generator(
    client: OpenAI,
    session: InterviewSession,
    chat_messages: list[dict],
    transcript_prefix: list[dict],
):
    """Stream tokens for live typing plus `sentence` events so TTS can run in parallel with later tokens."""
    full_text = ""
    buf = ""
    try:
        stream = client.chat.completions.create(
            model=OPENAI_MODEL,
            temperature=0.88,
            max_tokens=_interview_max_tokens(),
            messages=chat_messages,
            stream=True,
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content or ""
            if not delta:
                continue
            full_text += delta
            buf += delta
            yield _sse_event({"type": "token", "text": delta})
            frags, buf = _pop_tts_sentences(buf)
            for frag in frags:
                yield _sse_event({"type": "sentence", "text": frag})

        tail = re.sub(r"\[\[END_INTERVIEW\]\]\s*", "", buf, flags=re.I).strip()
        tail = re.sub(r"\[\[MAIN_QUESTION\]\]\s*", "", tail, flags=re.I).strip()
        if tail:
            yield _sse_event({"type": "sentence", "text": tail})

        reply, ended, is_main = parse_interview_reply_flags(full_text)
        if not reply:
            yield _sse_event({"type": "error", "message": "Empty model response"})
            return

        before_idx = int(session.main_question_index or 0)
        if is_main:
            session.main_question_index = before_idx + 1
            # Keep the UI progress meaningful if Riley continues beyond the initial target.
            if int(session.target_questions or 0) <= session.main_question_index:
                session.target_questions = min(12, session.main_question_index + 2)
            session.save(update_fields=["main_question_index", "target_questions", "updated_at"])
        elif before_idx == 0 and reply.strip():
            # First assistant reply with no marker — UI still needs Q1 of N (marker often omitted on opening).
            session.main_question_index = 1
            session.save(update_fields=["main_question_index", "updated_at"])

        # Send `done` first so the client can start TTS immediately; persistence runs after flush.
        yield _sse_event(
            {
                "type": "done",
                "reply": reply,
                "ended": ended,
                "main_q_index": int(session.main_question_index or 0),
                "main_q_target": max(1, int(session.target_questions or 0)),
                "is_main": bool(is_main),
            }
        )
        sync_transcript(
            session,
            [*transcript_prefix, {"role": "assistant", "content": reply}],
        )
    except Exception as e:
        logger.exception("stream_interview")
        yield _sse_event({"type": "error", "message": str(e)})


def sanitize_messages(messages) -> list[dict]:
    if not isinstance(messages, list):
        return []
    out = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if not isinstance(content, str):
            continue
        c = content.strip()
        if not c:
            continue
        out.append({"role": role, "content": c})
    return out


def _load_session(session_id, *, require_consent: bool = True):
    if not session_id:
        return None, _json_error("session_id required", 400)
    try:
        session = InterviewSession.objects.get(pk=session_id)
    except InterviewSession.DoesNotExist:
        return None, _json_error("session not found", 404)
    if require_consent and session.consent_at is None:
        return None, _json_error("session has no recorded consent", 400)
    if is_past_retention(session):
        return None, _json_error("session has expired per data retention policy", 410)
    return session, None


@csrf_exempt
def health(request):
    if request.method != "GET":
        return _json_error("Method not allowed", 405)
    c = _client()
    return JsonResponse({"ok": True, "openai": c is not None, "model": OPENAI_MODEL})


@csrf_exempt
def session_create(request):
    if request.method != "POST":
        return _json_error("Method not allowed", 405)
    try:
        body = json.loads(request.body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_error("Invalid JSON body", 400)
    if not body.get("consent"):
        return _json_error("consent must be true to start a session", 400)
    policy_version = str(body.get("policy_version", "2026-04-v1"))[:32]
    raw_name = body.get("candidate_name")
    if not isinstance(raw_name, str) or not raw_name.strip():
        return _json_error("candidate_name is required", 400)
    candidate_name = raw_name.strip()[:120]
    email = body.get("candidate_email") or ""
    if email and not isinstance(email, str):
        return _json_error("candidate_email must be a string", 400)
    try:
        retention_days = int(body.get("retention_days", 90))
    except (TypeError, ValueError):
        retention_days = 90
    retention_days = max(7, min(retention_days, 730))

    xfwd = request.META.get("HTTP_X_FORWARDED_FOR")
    if xfwd:
        client_ip = xfwd.split(",")[0].strip()[:45]
    else:
        client_ip = request.META.get("REMOTE_ADDR") or None

    session = InterviewSession.objects.create(
        consent_at=timezone.now(),
        consent_policy_version=policy_version,
        candidate_name=candidate_name,
        candidate_email=(email.strip()[:254] if isinstance(email, str) else ""),
        client_ip=client_ip,
        user_agent=(request.META.get("HTTP_USER_AGENT", ""))[:512],
        retention_until=timezone.now() + timedelta(days=retention_days),
        openai_model=OPENAI_MODEL,
        main_question_index=0,
        target_questions=int(os.environ.get("INTERVIEW_TARGET_QUESTIONS", "8") or 8),
    )
    return JsonResponse(
        {
            "session_id": str(session.id),
            "retention_until": session.retention_until.isoformat(),
            "policy_version": session.consent_policy_version,
        }
    )


@csrf_exempt
def interview_start(request):
    if request.method != "POST":
        return _json_error("Method not allowed", 405)
    client = _client()
    if not client:
        return _json_error(
            "OPENAI_API_KEY is not set. Add it to a .env file in tutor-screener/",
            503,
        )
    raw_body = request.body.decode("utf-8").strip() if request.body else ""
    try:
        body = json.loads(raw_body) if raw_body else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_error("Invalid JSON body", 400)
    session_id = body.get("session_id")
    session, err = _load_session(session_id)
    if err:
        return err

    try:
        sys_prompt = interviewer_system_for_session(candidate_name=session.candidate_name)
        # Reset progress metadata when (re)starting an interview.
        session.main_question_index = 0
        session.target_questions = max(4, min(12, int(session.target_questions or 8)))
        session.save(update_fields=["main_question_index", "target_questions", "updated_at"])
        completion = client.chat.completions.create(
            model=OPENAI_MODEL,
            temperature=0.88,
            max_tokens=_interview_max_tokens(),
            messages=[
                {"role": "system", "content": sys_prompt},
                {
                    "role": "user",
                    "content": start_user_message(candidate_name=session.candidate_name),
                },
            ],
        )
        text = (completion.choices[0].message.content or "").strip()
        reply, ended, is_main = parse_interview_reply_flags(text)
        before_idx = int(session.main_question_index or 0)
        if is_main:
            session.main_question_index = before_idx + 1
            session.save(update_fields=["main_question_index", "updated_at"])
        elif before_idx == 0 and (reply or "").strip():
            session.main_question_index = 1
            session.save(update_fields=["main_question_index", "updated_at"])
        msgs = [{"role": "assistant", "content": reply}]
        sync_transcript(session, msgs)
        session.openai_model = OPENAI_MODEL
        session.save(update_fields=["openai_model", "updated_at"])
        return JsonResponse(
            {
                "reply": reply,
                "ended": ended,
                "raw": text,
                "main_q_index": int(session.main_question_index or 0),
                "main_q_target": max(1, int(session.target_questions or 0)),
                "is_main": bool(is_main),
            }
        )
    except Exception as e:
        logger.exception("interview_start")
        return _json_error(str(e), 500)


@csrf_exempt
def interview_message(request):
    if request.method != "POST":
        return _json_error("Method not allowed", 405)
    client = _client()
    if not client:
        return _json_error(
            "OPENAI_API_KEY is not set. Add it to a .env file in tutor-screener/",
            503,
        )
    try:
        body = json.loads(request.body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_error("Invalid JSON body", 400)
    session, err = _load_session(body.get("session_id"))
    if err:
        return err
    sanitized = sanitize_messages(body.get("messages"))
    if not sanitized:
        return _json_error("messages must include at least one user/assistant turn", 400)
    if os.environ.get("OPENAI_MODERATION") == "1" and sanitized:
        last_user = next((m["content"] for m in reversed(sanitized) if m["role"] == "user"), "")
        if last_user:
            try:
                mod = client.moderations.create(input=last_user[:32_000])
                flagged = bool(
                    mod.results and getattr(mod.results[0], "flagged", False),
                )
                if flagged:
                    return _json_error("Content could not be processed (safety). Please rephrase.", 422)
            except Exception:
                logger.exception("moderation")

    last_u = last_user_turn(sanitized).strip()
    is_silent = is_no_spoken_reply_placeholder(last_u)
    if not is_silent and candidate_turn_too_long(last_u):
        return _json_error(
            "That answer is very long for this format. Try tightening to a minute or two of speech — "
            "you can always take another turn after Riley replies.",
            400,
        )
    silent_streak = refresh_silent_streak(session, is_silent)
    if silent_streak >= 2:
        reply, ended = forced_silent_reply_and_sync(
            session, sanitized, client=client, model=OPENAI_MODEL
        )
        return JsonResponse(
            {
                "reply": reply,
                "ended": ended,
                "forced_end": True,
                "silent_end": True,
                "raw": "",
                "engagement": "silent",
            }
        )

    if not is_silent:
        ok, rate_msg = check_and_record_candidate_message_rate(session)
        if not ok:
            return _json_error(rate_msg, 429)

    if is_silent:
        engagement = "substantive"
        extra_coach: list[str] = []
    else:
        engagement, extra_coach = preflight_interview_turn(
            client, sanitized, model=OPENAI_MODEL
        )
    bypass_streak = refresh_bypass_streak(session, engagement)
    if bypass_streak >= 2:
        reply, ended = forced_bypass_reply_and_sync(
            session, sanitized, client=client, model=OPENAI_MODEL
        )
        return JsonResponse(
            {
                "reply": reply,
                "ended": ended,
                "forced_end": True,
                "raw": "",
                "engagement": engagement,
            }
        )

    try:
        sys_prompt = interviewer_system_for_session(candidate_name=session.candidate_name)
        completion = client.chat.completions.create(
            model=OPENAI_MODEL,
            temperature=0.88,
            max_tokens=_interview_max_tokens(),
            messages=_interview_messages_for_model(sys_prompt, sanitized, extra_coach),
        )
        raw = (completion.choices[0].message.content or "").strip()
        reply, ended = parse_interview_reply(raw)
        sync_transcript(session, [*sanitized, {"role": "assistant", "content": reply}])
        return JsonResponse(
            {"reply": reply, "ended": ended, "raw": raw, "engagement": engagement}
        )
    except Exception as e:
        logger.exception("interview_message")
        return _json_error(str(e), 500)


@csrf_exempt
def interview_start_stream(request):
    """SSE: token deltas for live text plus `sentence` events for parallel clause TTS."""
    if request.method != "POST":
        return _json_error("Method not allowed", 405)
    client = _client()
    if not client:
        return _json_error(
            "OPENAI_API_KEY is not set. Add it to a .env file in tutor-screener/",
            503,
        )
    raw_body = request.body.decode("utf-8").strip() if request.body else ""
    try:
        body = json.loads(raw_body) if raw_body else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_error("Invalid JSON body", 400)
    session_id = body.get("session_id")
    session, err = _load_session(session_id)
    if err:
        return err

    # Match non-stream start: reset progress for this run so the bar doesn’t reuse stale counts.
    session.main_question_index = 0
    session.target_questions = max(4, min(12, int(session.target_questions or 8)))
    session.save(update_fields=["main_question_index", "target_questions", "updated_at"])

    sys_prompt = interviewer_system_for_session(candidate_name=session.candidate_name)

    def gen():
        try:
            for chunk in _stream_interview_generator(
                client,
                session,
                [
                    {"role": "system", "content": sys_prompt},
                    {
                        "role": "user",
                        "content": start_user_message(candidate_name=session.candidate_name),
                    },
                ],
                [],
            ):
                yield chunk
        finally:
            try:
                session.refresh_from_db()
                session.openai_model = OPENAI_MODEL
                session.save(update_fields=["openai_model", "updated_at"])
            except Exception:
                pass

    resp = StreamingHttpResponse(
        gen(),
        content_type="text/event-stream; charset=utf-8",
    )
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    return resp


@csrf_exempt
def interview_message_stream(request):
    if request.method != "POST":
        return _json_error("Method not allowed", 405)
    client = _client()
    if not client:
        return _json_error(
            "OPENAI_API_KEY is not set. Add it to a .env file in tutor-screener/",
            503,
        )
    try:
        body = json.loads(request.body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_error("Invalid JSON body", 400)
    session, err = _load_session(body.get("session_id"))
    if err:
        return err
    sanitized = sanitize_messages(body.get("messages"))
    if not sanitized:
        return _json_error("messages must include at least one user/assistant turn", 400)
    if os.environ.get("OPENAI_MODERATION") == "1" and sanitized:
        last_user = next((m["content"] for m in reversed(sanitized) if m["role"] == "user"), "")
        if last_user:
            try:
                mod = client.moderations.create(input=last_user[:32_000])
                flagged = bool(
                    mod.results and getattr(mod.results[0], "flagged", False),
                )
                if flagged:
                    return _json_error("Content could not be processed (safety). Please rephrase.", 422)
            except Exception:
                logger.exception("moderation")

    last_u = last_user_turn(sanitized).strip()
    is_silent = is_no_spoken_reply_placeholder(last_u)
    if not is_silent and candidate_turn_too_long(last_u):
        return _json_error(
            "That answer is very long for this format. Try tightening to a minute or two of speech — "
            "you can always take another turn after Riley replies.",
            400,
        )
    silent_streak = refresh_silent_streak(session, is_silent)
    if silent_streak >= 2:

        def silent_sse():
            reply, ended = forced_silent_reply_and_sync(
                session, sanitized, client=client, model=OPENAI_MODEL
            )
            session.refresh_from_db()
            yield _sse_event(
                {
                    "type": "done",
                    "reply": reply,
                    "ended": ended,
                    "forced_end": True,
                    "silent_end": True,
                    "engagement": "silent",
                    "main_q_index": int(session.main_question_index or 0),
                    "main_q_target": max(1, int(session.target_questions or 0)),
                }
            )

        resp = StreamingHttpResponse(
            silent_sse(),
            content_type="text/event-stream; charset=utf-8",
        )
        resp["Cache-Control"] = "no-cache"
        resp["X-Accel-Buffering"] = "no"
        return resp

    if not is_silent:
        ok, rate_msg = check_and_record_candidate_message_rate(session)
        if not ok:
            return _json_error(rate_msg, 429)

    if is_silent:
        engagement = "substantive"
        extra_coach_stream: list[str] = []
    else:
        engagement, extra_coach_stream = preflight_interview_turn(
            client, sanitized, model=OPENAI_MODEL
        )
    bypass_streak = refresh_bypass_streak(session, engagement)
    if bypass_streak >= 2:

        def forced_sse():
            reply, ended = forced_bypass_reply_and_sync(
                session, sanitized, client=client, model=OPENAI_MODEL
            )
            session.refresh_from_db()
            yield _sse_event(
                {
                    "type": "done",
                    "reply": reply,
                    "ended": ended,
                    "forced_end": True,
                    "engagement": engagement,
                    "main_q_index": int(session.main_question_index or 0),
                    "main_q_target": max(1, int(session.target_questions or 0)),
                }
            )

        resp = StreamingHttpResponse(
            forced_sse(),
            content_type="text/event-stream; charset=utf-8",
        )
        resp["Cache-Control"] = "no-cache"
        resp["X-Accel-Buffering"] = "no"
        return resp

    sys_prompt = interviewer_system_for_session(candidate_name=session.candidate_name)
    chat = _interview_messages_for_model(
        sys_prompt, sanitized, extra_coach_stream
    )
    resp = StreamingHttpResponse(
        _stream_interview_generator(
            client,
            session,
            chat,
            sanitized,
        ),
        content_type="text/event-stream; charset=utf-8",
    )
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    return resp


@csrf_exempt
def interview_assess(request):
    if request.method != "POST":
        return _json_error("Method not allowed", 405)
    client = _client()
    if not client:
        return _json_error(
            "OPENAI_API_KEY is not set. Add it to a .env file in tutor-screener/",
            503,
        )
    try:
        body = json.loads(request.body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_error("Invalid JSON body", 400)
    session, err = _load_session(body.get("session_id"))
    if err:
        return err
    transcript = body.get("transcript")
    if not isinstance(transcript, str) or not transcript.strip():
        transcript = transcript_plain(session)
    transcript = transcript.strip()[:120_000]
    if not transcript:
        return _json_error("transcript empty", 400)
    closure = (session.closure_reason or "").strip() or "none"
    assess_user = (
        "Platform metadata (authoritative — not spoken in the interview):\n"
        f'closure_reason: "{closure}"\n\n'
        "Transcript (Interviewer / Candidate):\n\n"
        f"{transcript}"
    )
    try:
        completion = client.chat.completions.create(
            model=OPENAI_MODEL,
            temperature=0.3,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": ASSESSOR_SYSTEM},
                {"role": "user", "content": assess_user},
            ],
        )
        text = completion.choices[0].message.content or "{}"
        try:
            assessment = json.loads(text)
        except json.JSONDecodeError:
            return JsonResponse({"error": "Invalid JSON from model", "raw": text}, status=502)
        if session.closure_reason == CLOSURE_REASON_SILENT:
            hns = assessment.get("hiring_next_step")
            if not isinstance(hns, dict):
                hns = {}
            if hns.get("type") != "contact_candidate_verify_interest":
                hns["type"] = "contact_candidate_verify_interest"
            if not (str(hns.get("guidance_for_panel") or "").strip()):
                hns["guidance_for_panel"] = (
                    "This session ended after repeated turns with no spoken reply from the candidate "
                    "(the flow assumes the mic was available). Before a final decision, the hiring panel "
                    "should contact the candidate to confirm genuine interest in the role and whether "
                    "technical or personal circumstances interfered—this is a process edge case, not "
                    "necessarily disinterest."
                )
            assessment["hiring_next_step"] = hns
        if not isinstance(assessment.get("hiring_next_step"), dict):
            assessment["hiring_next_step"] = {
                "type": "standard_review",
                "guidance_for_panel": "",
            }
        AssessmentRecord.objects.update_or_create(
            session=session,
            defaults={"payload": assessment},
        )
        mark_completed(session)
        return JsonResponse({"assessment": assessment})
    except Exception as e:
        logger.exception("interview_assess")
        return _json_error(str(e), 500)


@csrf_exempt
def transcribe(request):
    if request.method != "POST":
        return _json_error("Method not allowed", 405)
    client = _client()
    if not client:
        return _json_error(
            "OPENAI_API_KEY is not set. Add it to a .env file in tutor-screener/",
            503,
        )
    session_id = request.POST.get("session_id")
    session, err = _load_session(session_id)
    if err:
        return err
    if "audio" not in request.FILES:
        return _json_error("Missing audio file field 'audio'", 400)
    uploaded = request.FILES["audio"]
    data = uploaded.read()
    if not data:
        return _json_error("Empty audio upload", 400)
    filename = getattr(uploaded, "name", None) or "speech.webm"
    buf = io.BytesIO(data)
    buf.name = filename
    try:
        transcription = client.audio.transcriptions.create(
            model=TRANSCRIBE_MODEL,
            file=buf,
        )
        return JsonResponse({"text": transcription.text or ""})
    except Exception as e:
        logger.exception("transcribe")
        return _json_error(str(e), 500)


@csrf_exempt
def tts_speak(request):
    """OpenAI Text-to-Speech — returns audio/mpeg for natural interviewer voice."""
    if request.method != "POST":
        return _json_error("Method not allowed", 405)
    client = _client()
    if not client:
        return _json_error(
            "OPENAI_API_KEY is not set. Add it to a .env file in tutor-screener/",
            503,
        )
    try:
        body = json.loads(request.body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_error("Invalid JSON body", 400)
    session_id = body.get("session_id")
    session, err = _load_session(session_id, require_consent=False)
    if err:
        return err
    text = (body.get("text") or "").strip()
    if not text:
        return _json_error("text required", 400)
    if len(text) > MAX_TTS_CHARS:
        text = text[: MAX_TTS_CHARS - 3] + "..."
    try:
        speech = client.audio.speech.create(
            model=OPENAI_TTS_MODEL,
            voice=OPENAI_TTS_VOICE,
            input=text,
            response_format="mp3",
        )
        return HttpResponse(speech.content, content_type="audio/mpeg")
    except Exception as e:
        logger.exception("tts_speak")
        return _json_error(str(e), 500)


def serve_public(request, path=""):
    """Serve files from public/; unknown paths fall back to index.html for the SPA."""
    path = (path or "").strip("/")
    if not path:
        return FileResponse(open(PUBLIC_ROOT / "index.html", "rb"), content_type="text/html")
    try:
        full = safe_join(str(PUBLIC_ROOT), path)
    except SuspiciousOperation:
        full = None
    if full and Path(full).is_file():
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        return FileResponse(open(full, "rb"), content_type=ctype)
    return FileResponse(open(PUBLIC_ROOT / "index.html", "rb"), content_type="text/html")


@csrf_exempt
def report_pdf(request):
    """Generate a simple PDF summary for a completed session."""
    if request.method != "GET":
        return _json_error("Method not allowed", 405)
    session_id = request.GET.get("session_id")
    session, err = _load_session(session_id, require_consent=False)
    if err:
        return err
    ar = getattr(session, "assessment", None)
    payload = getattr(ar, "payload", None) if ar else None
    if not isinstance(payload, dict):
        return _json_error("No assessment available yet for this session", 404)

    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import mm
        from reportlab.pdfgen import canvas
    except Exception:
        return _json_error("PDF generation dependency missing. Install reportlab.", 500)

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    width, height = A4

    def draw_wrapped(text: str, x: float, y: float, max_w: float, leading: float = 14):
        """Draw text with crude word-wrapping; returns new y."""
        if not text:
            return y
        words = str(text).split()
        line = ""
        for w in words:
            test = (line + " " + w).strip()
            if c.stringWidth(test, "Helvetica", 10) <= max_w:
                line = test
            else:
                c.drawString(x, y, line)
                y -= leading
                line = w
        if line:
            c.drawString(x, y, line)
            y -= leading
        return y

    name = session.candidate_name or "Candidate"
    meta = f"Session {session.id} · {session.created_at.strftime('%Y-%m-%d %H:%M UTC')}"
    c.setTitle(f"Cuemath Screener Report - {name}")

    y = height - 20 * mm
    c.setFont("Helvetica-Bold", 16)
    c.drawString(18 * mm, y, "Cuemath AI Tutor Screener — Report")
    y -= 10 * mm
    c.setFont("Helvetica-Bold", 13)
    c.drawString(18 * mm, y, name)
    y -= 6 * mm
    c.setFont("Helvetica", 10)
    c.drawString(18 * mm, y, meta)
    y -= 10 * mm

    rec = str(payload.get("recommendation") or "maybe").replace("_", " ")
    c.setFont("Helvetica-Bold", 11)
    c.drawString(18 * mm, y, f"Verdict: {rec}")
    y -= 7 * mm

    dims = payload.get("dimensions") if isinstance(payload.get("dimensions"), dict) else {}
    scores = []
    for v in dims.values():
        try:
            scores.append(float(v.get("score")))
        except Exception:
            pass
    overall = round((sum(scores) / len(scores)) / 5 * 100) if scores else None
    c.setFont("Helvetica", 10)
    c.drawString(18 * mm, y, f"Overall score: {overall if overall is not None else '—'} / 100")
    y -= 10 * mm

    c.setFont("Helvetica-Bold", 11)
    c.drawString(18 * mm, y, "Summary")
    y -= 6 * mm
    c.setFont("Helvetica", 10)
    y = draw_wrapped(payload.get("summary") or "", 18 * mm, y, width - 36 * mm, 13)
    y -= 4 * mm

    c.setFont("Helvetica-Bold", 11)
    c.drawString(18 * mm, y, "Dimension scores (1–5)")
    y -= 7 * mm
    c.setFont("Helvetica", 10)
    for key in ("clarity", "warmth", "simplicity", "patience", "fluency"):
        d = dims.get(key) if isinstance(dims, dict) else None
        if not isinstance(d, dict):
            continue
        score = d.get("score")
        comment = d.get("comment") or ""
        c.setFont("Helvetica-Bold", 10)
        c.drawString(18 * mm, y, f"{key.title()}: {score}/5")
        y -= 5 * mm
        c.setFont("Helvetica", 10)
        y = draw_wrapped(comment, 22 * mm, y, width - 40 * mm, 12)
        y -= 2 * mm
        if y < 35 * mm:
            c.showPage()
            y = height - 20 * mm

    def bullet_list(title: str, items):
        nonlocal y
        if not items:
            return
        if y < 45 * mm:
            c.showPage()
            y = height - 20 * mm
        c.setFont("Helvetica-Bold", 11)
        c.drawString(18 * mm, y, title)
        y -= 7 * mm
        c.setFont("Helvetica", 10)
        for it in items:
            y = draw_wrapped(f"• {it}", 20 * mm, y, width - 40 * mm, 12)
            if y < 35 * mm:
                c.showPage()
                y = height - 20 * mm

    bullet_list("Key strengths", payload.get("strengths") or [])
    bullet_list("Areas to develop", payload.get("risks") or [])
    bullet_list("Suggested follow-ups", payload.get("follow_up_questions") or [])

    hns = payload.get("hiring_next_step") if isinstance(payload.get("hiring_next_step"), dict) else {}
    guidance = (hns.get("guidance_for_panel") or "").strip()
    if guidance:
        bullet_list("Hiring panel note", [guidance])

    c.showPage()
    c.save()
    buf.seek(0)
    filename = f"cuemath-screener-{session.id}.pdf"
    resp = FileResponse(buf, content_type="application/pdf")
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp
