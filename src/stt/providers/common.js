import { SttError, upstreamError } from "../error.js";

export function audioContentType(file) {
  const type = String(file?.type || "").toLowerCase();
  if (type.startsWith("audio/")) return type;
  const extension = String(file?.name || "").toLowerCase().split(".").pop();
  return ({ mp3: "audio/mpeg", mp4: "audio/mp4", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm", aac: "audio/aac", opus: "audio/opus" })[extension]
    || "application/octet-stream";
}

export async function assertUpstreamOk(response, provider) {
  if (response.ok) return;
  // Provider response bodies can contain details about account configuration.
  // Consume but do not expose or log them.
  try { await response.text(); } catch {}
  throw upstreamError(provider, response.status);
}

export async function responseJson(response, provider) {
  try {
    return await response.json();
  } catch {
    throw new SttError(`${provider} returned an invalid response`, {
      status: 502, code: "upstream_invalid_response", type: "provider_error", provider,
    });
  }
}

export function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Keep an upstream HTTP request from outliving the gateway operation. The
 * caller can still inject a fake fetch implementation in contract tests; the
 * signal is part of the normal fetch contract and is ignored by simple fakes.
 */
export async function fetchWithTimeout(fetchImpl, url, options, { provider, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
  const timer = setTimeout(() => controller.abort(), boundedTimeout);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SttError(`${provider} upstream request timed out`, {
        status: 504,
        code: "upstream_timeout",
        type: "provider_error",
        provider: provider?.toLowerCase(),
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function compactMetadata(source, names) {
  const metadata = {};
  for (const name of names) {
    if (source?.[name] !== undefined && source[name] !== null) metadata[name] = source[name];
  }
  return metadata;
}
