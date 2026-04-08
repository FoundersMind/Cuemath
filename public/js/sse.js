import { state } from "./state.js";
import { setBusy } from "./ui.js";
import { enqueueAssistantReplyClauses, enqueueAssistantSpeakChunk } from "./tts.js";
import { createInterviewerStreamDisplay } from "./streaming-text.js";

/**
 * Interview SSE: tokens type smoothly; each `sentence` starts TTS for that clause while more tokens
 * may still arrive. Text is synced to audio via revealThroughClause right before each clip.
 * If the model never emitted mid-stream sentences, `done` falls back to clause-split TTS.
 * @returns {Promise<{reply: string, ended: boolean}>}
 */
export async function consumeInterviewStreamBody(response) {
  const streamDisplay = createInterviewerStreamDisplay();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let donePayload = null;
  let hadSentenceAudio = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const parts = carry.split("\n\n");
      carry = parts.pop() || "";
      for (const block of parts) {
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (payload.type === "token" && payload.text) {
          if (state.busy) setBusy(false);
          streamDisplay.appendDelta(payload.text);
        } else if (payload.type === "sentence" && payload.text) {
          hadSentenceAudio = true;
          enqueueAssistantSpeakChunk(payload.text, true, streamDisplay);
        } else if (payload.type === "done") {
          if (state.busy) setBusy(false);
          donePayload = payload;
          const reply = (payload.reply || "").trim();
          streamDisplay.finishToTarget(reply);
        } else if (payload.type === "error") {
          throw new Error(payload.message || "Stream error");
        }
      }
    }
    if (!donePayload) throw new Error("Interview stream incomplete");
    const reply = (donePayload.reply || "").trim();
    if (reply && !hadSentenceAudio) {
      enqueueAssistantReplyClauses(reply, streamDisplay, true);
    }
    return donePayload;
  } catch (e) {
    streamDisplay.cancel();
    throw e;
  }
}
