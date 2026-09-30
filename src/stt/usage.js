// Store only operational fields in usageHistory.meta. In particular, audio,
// transcript text, authorization values, and provider credentials never enter it.
export async function recordSttUsage({
  requestId, provider, model, mode, language, connectionId = null,
  audioSeconds = null, latencyMs, firstResultMs = null, finalResultMs = null,
  status, errorCode = null, runtime = false,
}) {
  const metadata = {
    request_id: requestId,
    mode,
    language,
    audio_seconds: Number.isFinite(audioSeconds) ? audioSeconds : null,
    latency_ms: Math.round(latencyMs || 0),
    first_result_ms: Number.isFinite(firstResultMs) ? Math.round(firstResultMs) : null,
    final_result_ms: Number.isFinite(finalResultMs) ? Math.round(finalResultMs) : null,
    error_code: errorCode || null,
  };
  try {
    if (runtime) {
      const { recordRuntimeSttUsage } = await import("./runtimeDb.js");
      await recordRuntimeSttUsage({ provider, model, mode, connectionId, status, metadata });
    } else {
      const { getAdapter } = await import("../lib/db/driver.js");
      const db = await getAdapter();
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, ?, ?, NULL, ?, 0, 0, 0, ?, ?, ?)`,
        [
          new Date().toISOString(), provider, model, connectionId, `/v1/${mode === "batch" ? "audio/transcriptions" : "realtime"}`,
          status, JSON.stringify({}), JSON.stringify(metadata),
        ],
      );
    }
  } catch {
    // Usage telemetry cannot make a completed clinical transcription fail.
    console.warn("[stt] usage tracking unavailable");
  }
}
