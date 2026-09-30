import { SttError } from "../error.js";
import { transcribeDeepgram } from "./deepgram/batch.js";
import { transcribeSpeechmatics } from "./speechmatics/batch.js";

export async function transcribeWithProvider(request) {
  if (request.provider === "deepgram") return transcribeDeepgram(request);
  if (request.provider === "speechmatics") return transcribeSpeechmatics(request);
  throw new SttError("Unsupported STT provider", { status: 400, code: "invalid_provider" });
}
