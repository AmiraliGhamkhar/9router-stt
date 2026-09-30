import { SttError } from "../error.js";
import { DeepgramRealtimeProvider } from "./deepgram/realtime.js";
import { SpeechmaticsRealtimeProvider } from "./speechmatics/realtime.js";

export function createRealtimeProvider(config) {
  if (config.provider === "deepgram") return new DeepgramRealtimeProvider(config);
  if (config.provider === "speechmatics") return new SpeechmaticsRealtimeProvider(config);
  throw new SttError("Unsupported STT provider", { status: 400, code: "invalid_provider" });
}
