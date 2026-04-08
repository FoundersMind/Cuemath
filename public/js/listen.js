import { POST_TTS_LISTEN_DELAY_MS } from "./config.js";
import { state } from "./state.js";

let startRecordingImpl = async () => {};

export function registerStartRecording(fn) {
  startRecordingImpl = fn;
}

export function scheduleAutoListen() {
  if (state.interviewEnded || state.busy) return;
  setTimeout(() => {
    if (state.interviewEnded || state.busy || state.speaking) return;
    void startRecordingImpl();
  }, POST_TTS_LISTEN_DELAY_MS);
}
