import { SttError } from "../../error.js";
import { assertUpstreamOk, audioContentType, compactMetadata, responseJson } from "../common.js";

const ENDPOINT = "https://api.deepgram.com/v1/listen";

function toSegments(words) {
  if (!Array.isArray(words)) return undefined;
  return words.map((word) => {
    const segment = { text: word.word };
    if (typeof word.start === "number") segment.start_time = word.start;
    if (typeof word.end === "number") segment.end_time = word.end;
    if (typeof word.confidence === "number") segment.confidence = word.confidence;
    if (typeof word.speaker === "number" || typeof word.speaker === "string") segment.speaker = word.speaker;
    return segment;
  });
}

/** Deepgram prerecorded STT adapter. Uses the existing raw-audio /v1/listen shape. */
export async function transcribeDeepgram({ file, model, language, token, verbose = false, fetchImpl = fetch }) {
  const url = new URL(process.env.DEEPGRAM_BATCH_URL || ENDPOINT);
  url.searchParams.set("model", model);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  if (language) url.searchParams.set("language", language);
  else url.searchParams.set("detect_language", "true");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": audioContentType(file) },
    body: await file.arrayBuffer(),
  });
  await assertUpstreamOk(response, "Deepgram");
  const payload = await responseJson(response, "Deepgram");
  const alternative = payload?.results?.channels?.[0]?.alternatives?.[0];
  if (!alternative || typeof alternative.transcript !== "string") {
    throw new SttError("Deepgram returned no transcript", {
      status: 502, code: "upstream_invalid_response", type: "provider_error", provider: "deepgram",
    });
  }

  const result = {
    text: alternative.transcript,
    audioSeconds: typeof payload?.metadata?.duration === "number" ? payload.metadata.duration : null,
  };
  if (verbose) {
    const metadata = compactMetadata(payload.metadata, ["duration", "channels", "request_id"]);
    if (Object.keys(metadata).length) result.metadata = metadata;
    const segments = toSegments(alternative.words);
    if (segments) result.segments = segments;
  }
  return result;
}
