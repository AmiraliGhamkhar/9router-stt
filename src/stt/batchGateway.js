import { authenticateGatewayRequest, isTrustedLoopbackRequest } from "./auth.js";
import { getProviderCredential } from "./credentials.js";
import { publicError, SttError } from "./error.js";
import { transcribeWithProvider } from "./providers/batch.js";
import { createSttRequestId } from "./requestId.js";
import { resolveSttRoute } from "./routing.js";
import { recordSttUsage } from "./usage.js";

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function maxUploadBytes() {
  const value = Number(process.env.STT_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_UPLOAD_BYTES;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.STT_CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function asFile(value) {
  return value && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.size === "number";
}

export async function handleBatchTranscription(request) {
  const requestId = createSttRequestId();
  const auth = await authenticateGatewayRequest(request.headers, {
    isLoopback: isTrustedLoopbackRequest(request.headers),
  });
  if (!auth.ok) {
    return json({ error: { message: "Invalid or missing gateway API key", type: "authentication_error", code: "invalid_api_key", request_id: requestId } }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return json({ error: { message: "Content-Type must be multipart/form-data", type: "invalid_request_error", code: "invalid_content_type", request_id: requestId } }, { status: 400 });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: { message: "Invalid multipart form data", type: "invalid_request_error", code: "invalid_multipart", request_id: requestId } }, { status: 400 });
  }

  const file = form.get("file");
  if (!asFile(file)) {
    return json({ error: { message: "Missing required field: file", type: "invalid_request_error", code: "missing_file", request_id: requestId } }, { status: 400 });
  }
  if (file.size === 0) {
    return json({ error: { message: "Audio file must not be empty", type: "invalid_request_error", code: "empty_audio", request_id: requestId } }, { status: 400 });
  }
  if (file.size > maxUploadBytes()) {
    return json({ error: { message: "Audio file exceeds the configured upload limit", type: "invalid_request_error", code: "audio_too_large", request_id: requestId } }, { status: 413 });
  }

  const startedAt = Date.now();
  let route;
  let credential;
  try {
    route = resolveSttRoute({
      provider: form.get("provider") || "auto",
      model: form.get("model"),
      language: form.get("language"),
      profile: form.get("profile") || "general",
      mode: "batch",
    });
    credential = await getProviderCredential(route.provider);
    if (!credential) {
      throw new SttError(`No server-side credentials are configured for ${route.provider}`, {
        status: 503, code: "provider_unavailable", type: "provider_error", provider: route.provider,
      });
    }

    const verbose = String(form.get("response_format") || "").toLowerCase() === "verbose_json";
    const result = await transcribeWithProvider({ ...route, file, token: credential.token, verbose });
    const response = {
      text: result.text,
      provider: route.provider,
      model: route.model,
      request_id: requestId,
    };
    if (verbose && result.metadata) response.metadata = result.metadata;
    if (verbose && result.segments) response.segments = result.segments;

    await recordSttUsage({
      requestId, provider: route.provider, model: route.model, mode: "batch", language: route.language,
      connectionId: credential.connectionId, audioSeconds: result.audioSeconds,
      latencyMs: Date.now() - startedAt, status: "ok",
    });
    console.info(`[stt] batch request_id=${requestId} provider=${route.provider} model=${route.model} status=ok latency_ms=${Date.now() - startedAt}`);
    return json(response);
  } catch (error) {
    const { status, body } = publicError(error, requestId);
    await recordSttUsage({
      requestId, provider: route?.provider || "unknown", model: route?.model || String(form.get("model") || "unknown"),
      mode: "batch", language: route?.language || String(form.get("language") || "unknown"),
      connectionId: credential?.connectionId || null, latencyMs: Date.now() - startedAt,
      status: "error", errorCode: body.error.code,
    });
    console.warn(`[stt] batch request_id=${requestId} provider=${route?.provider || "unknown"} status=error code=${body.error.code}`);
    return json(body, { status });
  }
}

export function batchCorsHeaders() {
  return corsHeaders();
}
