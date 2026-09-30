import { SttError, upstreamError } from "../../error.js";
import { assertUpstreamOk, compactMetadata, responseJson, wait } from "../common.js";

const API_BASE = "https://eu1.asr.api.speechmatics.com/v2";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

function endpoint(path) {
  return `${(process.env.SPEECHMATICS_BATCH_URL || API_BASE).replace(/\/$/, "")}${path}`;
}

function joinResults(results) {
  let text = "";
  for (const result of results || []) {
    const content = result?.alternatives?.[0]?.content;
    if (typeof content !== "string" || !content) continue;
    if (!text || result.attaches_to === "previous" || result.type === "punctuation") text += content;
    else text += ` ${content}`;
  }
  return text.trim();
}

function toSegments(results) {
  if (!Array.isArray(results)) return undefined;
  return results.map((item) => {
    const alternative = item?.alternatives?.[0] || {};
    const segment = { text: alternative.content || "" };
    if (typeof item.start_time === "number") segment.start_time = item.start_time;
    if (typeof item.end_time === "number") segment.end_time = item.end_time;
    if (typeof alternative.confidence === "number") segment.confidence = alternative.confidence;
    if (alternative.language) segment.language = alternative.language;
    if (alternative.speaker) segment.speaker = alternative.speaker;
    return segment;
  }).filter((segment) => segment.text);
}

async function pollJob(id, token, fetchImpl, deadline) {
  while (Date.now() < deadline) {
    const response = await fetchImpl(endpoint(`/jobs/${encodeURIComponent(id)}`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    await assertUpstreamOk(response, "Speechmatics");
    const job = await responseJson(response, "Speechmatics");
    const status = String(job?.job?.status || job?.status || "").toLowerCase();
    if (status === "done") return job;
    if (["rejected", "failed", "error", "cancelled"].includes(status)) {
      throw new SttError("Speechmatics batch job failed", {
        status: 502, code: "upstream_job_failed", type: "provider_error", provider: "speechmatics",
      });
    }
    await wait(POLL_INTERVAL_MS);
  }
  throw new SttError("Speechmatics batch job timed out", {
    status: 504, code: "upstream_timeout", type: "provider_error", provider: "speechmatics",
  });
}

/** Speechmatics Jobs API adapter. Audio remains in memory until it is sent upstream. */
export async function transcribeSpeechmatics({ file, model, language, token, verbose = false, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const config = {
    type: "transcription",
    transcription_config: { language, model },
  };
  const form = new FormData();
  form.append("data_file", file, file.name || "audio.wav");
  form.append("config", JSON.stringify(config));

  const submission = await fetchImpl(endpoint("/jobs"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  await assertUpstreamOk(submission, "Speechmatics");
  const submitted = await responseJson(submission, "Speechmatics");
  const jobId = submitted?.id || submitted?.job?.id;
  if (!jobId) {
    throw new SttError("Speechmatics returned no batch job id", {
      status: 502, code: "upstream_invalid_response", type: "provider_error", provider: "speechmatics",
    });
  }

  const job = await pollJob(jobId, token, fetchImpl, Date.now() + timeoutMs);
  const transcriptResponse = await fetchImpl(endpoint(`/jobs/${encodeURIComponent(jobId)}/transcript?format=json-v2`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!transcriptResponse.ok) {
    try { await transcriptResponse.text(); } catch {}
    throw upstreamError("Speechmatics", transcriptResponse.status);
  }
  const transcript = await responseJson(transcriptResponse, "Speechmatics");
  const result = {
    text: joinResults(transcript.results),
    audioSeconds: typeof transcript?.job?.duration === "number"
      ? transcript.job.duration
      : (typeof job?.job?.duration === "number" ? job.job.duration : null),
  };
  if (verbose) {
    const metadata = compactMetadata(transcript.job || job.job || job, ["id", "duration", "created_at"]);
    if (Object.keys(metadata).length) result.metadata = metadata;
    const segments = toSegments(transcript.results);
    if (segments) result.segments = segments;
  }
  return result;
}
