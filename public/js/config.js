/**
 * Quiet stretch before auto-stop (ms). Keep generous so candidates can pause to think
 * mid-answer without the clip ending early; wrong value feels like the AI “cuts them off.”
 */
export const VAD_SILENCE_END_MS = 3200;
/** Minimum recording length before auto-stop can fire. */
export const VAD_MIN_MS = 900;
/** RMS threshold on float time-domain (tune if noisy room). */
export const VAD_RMS_THRESHOLD = 0.028;
/** After Riley finishes speaking, wait before opening mic (thinking room + echo guard). */
export const POST_TTS_LISTEN_DELAY_MS = 1200;
/**
 * If the mic is open this long with **no** sound above VAD, treat as no candidate reply and let Riley respond.
 */
export const LISTEN_NO_SPEECH_TIMEOUT_MS = 28_000;
/** While listening with no voice yet, show a mic-check hint once after this many ms. */
export const LISTEN_NO_VOICE_HINT_MS = 12_000;
/** If auto-open mic didn’t start after Riley speaks, try opening again (getUserMedia / focus quirks). */
export const LISTEN_MIC_RETRY_MS = 3200;
/**
 * Sent as the candidate user line when they send nothing (silence timeout, or empty transcript with no VAD).
 * **Must match** `api/interview_constants.py` → `NO_SPOKEN_REPLY_PLACEHOLDER`.
 */
export const NO_CANDIDATE_REPLY_PLACEHOLDER =
  "[No spoken reply from the candidate on this turn.]";
/** Silence prepended after decode before playing each TTS chunk that uses lead-in (ms). */
export const TTS_LEAD_IN_MS = 80;

/**
 * Interviewer typing speed: **fixed** visible characters per second (no catch-up bursts — easier
 * to read along at a pace closer to steady speech). Raise slightly if text lags behind TTS; lower
 * to make it easier to match aloud.
 */
export const STREAMING_TEXT_CHARS_PER_SEC = 28;
