import { timingSafeEqual } from "node:crypto";

function firstHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || null;
}

export function extractGatewayApiKey(headers) {
  const authorization = firstHeader(headers, "authorization");
  if (typeof authorization === "string" && /^Bearer\s+\S+$/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  const apiKey = firstHeader(headers, "x-api-key");
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();

  // Browser WebSocket clients cannot set Authorization. They may use
  // new WebSocket(url, ["stt", gatewayKey]); the server only negotiates "stt".
  const protocols = firstHeader(headers, "sec-websocket-protocol");
  if (typeof protocols === "string") {
    const values = protocols.split(",").map((value) => value.trim()).filter(Boolean);
    const sttIndex = values.indexOf("stt");
    if (sttIndex !== -1 && values[sttIndex + 1]) return values[sttIndex + 1];
  }
  return null;
}

function sameSecret(candidate, configured) {
  if (!candidate || !configured) return false;
  const candidateBytes = Buffer.from(candidate);
  const configuredBytes = Buffer.from(configured);
  return candidateBytes.length === configuredBytes.length && timingSafeEqual(candidateBytes, configuredBytes);
}

export function isLoopbackAddress(address) {
  const value = String(address || "").toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

// custom-server.js replaces its peer headers after reading the TCP peer and
// proves that with its per-process secret. It adds x-stt-local-proof only for
// a direct loopback peer, because Next can hide x-9r headers from route code.
export function isTrustedLoopbackRequest(headers) {
  if (sameSecret(firstHeader(headers, "x-stt-local-proof"), process.env.NINEROUTER_PEER_TOKEN)) return true;
  return sameSecret(firstHeader(headers, "x-9r-peer-token"), process.env.NINEROUTER_PEER_TOKEN)
    && isLoopbackAddress(firstHeader(headers, "x-9r-real-ip"));
}

function unsafeLocalDevelopmentEnabled(isLoopback) {
  // The bypass is explicitly opt-in and requires the custom server's
  // loopback-only proof. It remains safe even if a deployment accidentally
  // carries the flag because proxy/remote requests never receive that proof.
  return process.env.STT_ALLOW_INSECURE_LOCAL === "true" && isLoopback;
}

export async function authenticateGatewayRequest(headers, { isLoopback = false, runtime = false } = {}) {
  if (unsafeLocalDevelopmentEnabled(isLoopback)) return { ok: true, source: "development" };

  const apiKey = extractGatewayApiKey(headers);
  if (!apiKey) return { ok: false };

  if (sameSecret(apiKey, process.env.STT_GATEWAY_API_KEY)) return { ok: true, source: "environment" };

  // The long-running server uses a direct read-only SQLite lookup while Next
  // route handlers use the existing API-key repository. Both fail closed.
  try {
    if (runtime) {
      const { validateRuntimeApiKey } = await import("./runtimeDb.js");
      if (await validateRuntimeApiKey(apiKey)) return { ok: true, source: "database" };
    } else {
      const { validateApiKey } = await import("../lib/db/repos/apiKeysRepo.js");
      if (await validateApiKey(apiKey)) return { ok: true, source: "database" };
    }
  } catch {
    // A database failure must fail closed; do not make an STT endpoint public.
  }
  return { ok: false };
}
