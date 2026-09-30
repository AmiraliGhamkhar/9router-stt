import { WebSocketServer, WebSocket } from "ws";
import { authenticateGatewayRequest, isTrustedLoopbackRequest } from "./auth.js";
import { getProviderCredential } from "./credentials.js";
import { SttError } from "./error.js";
import { createRealtimeProvider } from "./providers/realtime.js";
import { createSttRequestId } from "./requestId.js";
import { resolveSttRoute } from "./routing.js";
import { recordSttUsage } from "./usage.js";

const CONTROL_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 100;

function numericEnvironment(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function writeUpgradeFailure(socket, status, message) {
  if (!socket.writable) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}


function isRealtimePath(request) {
  try {
    return new URL(request.url, "http://gateway.invalid").pathname === "/v1/realtime";
  } catch {
    return false;
  }
}

function validAudioFormat(sampleRate, encoding) {
  return Number.isInteger(sampleRate)
    && sampleRate >= 8_000
    && sampleRate <= 48_000
    && ["pcm_s16le", "pcm_f32le", "mulaw"].includes(encoding);
}

function audioSecondsForFrame(frame, config) {
  const bytesPerSample = config.encoding === "pcm_f32le" ? 4 : (config.encoding === "pcm_s16le" ? 2 : 1);
  return frame.length / (config.sampleRate * bytesPerSample);
}

function normalizeClientConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SttError("First message must be a session configuration object", { status: 400, code: "invalid_session_config" });
  }
  const sampleRate = Number(value.sample_rate);
  const encoding = String(value.encoding || "").toLowerCase();
  if (!validAudioFormat(sampleRate, encoding)) {
    throw new SttError("Unsupported audio format", { status: 400, code: "invalid_audio_format" });
  }
  return {
    provider: value.provider || "auto",
    model: value.model,
    language: value.language,
    profile: value.profile || "general",
    sampleRate,
    encoding,
  };
}

export function createRealtimeUpgradeHandler() {
  const maxConnections = numericEnvironment("STT_REALTIME_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS);
  const maxFrameBytes = numericEnvironment("STT_REALTIME_MAX_FRAME_BYTES", DEFAULT_MAX_FRAME_BYTES);
  const idleMs = numericEnvironment("STT_REALTIME_IDLE_MS", DEFAULT_IDLE_MS);
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: maxFrameBytes,
    handleProtocols: (protocols) => (protocols.has("stt") ? "stt" : false),
  });
  let activeConnections = 0;

  wss.on("connection", (ws) => {
    activeConnections += 1;
    const requestId = createSttRequestId();
    const startedAt = Date.now();
    let config = null;
    let route = null;
    let credential = null;
    let provider = null;
    let audioSeconds = 0;
    let firstResultMs = null;
    let finalResultMs = null;
    let lastActivity = Date.now();
    let ended = false;
    let sequence = Promise.resolve();

    const configTimer = setTimeout(() => {
      sendError("session_configuration_timeout", "Realtime session configuration timed out");
      void finish("error", "session_configuration_timeout", true);
    }, CONTROL_TIMEOUT_MS);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > idleMs) {
        sendError("idle_timeout", "Realtime session timed out while idle");
        finish("error", "idle_timeout", true);
      }
    }, Math.min(idleMs, 5_000));
    idleTimer.unref?.();

    function sendError(code, message, type = "invalid_request_error") {
      send(ws, { type: "error", error: { message, type, code, request_id: requestId } });
    }

    async function finish(status = "ok", errorCode = null, closeClient = false) {
      if (ended) return;
      ended = true;
      clearTimeout(configTimer);
      clearInterval(idleTimer);
      try { await provider?.close(); } catch {}
      await recordSttUsage({
        requestId, provider: route?.provider || "unknown", model: route?.model || "unknown", mode: "realtime",
        language: route?.language || "unknown", connectionId: credential?.connectionId || null,
        audioSeconds, latencyMs: Date.now() - startedAt, firstResultMs, finalResultMs,
        status, errorCode, runtime: true,
      });
      console.info(`[stt] realtime request_id=${requestId} provider=${route?.provider || "unknown"} status=${status}${errorCode ? ` code=${errorCode}` : ""}`);
      activeConnections = Math.max(0, activeConnections - 1);
      if (closeClient && ws.readyState === WebSocket.OPEN) ws.close(status === "ok" ? 1000 : 1011);
    }

    function bindProvider(adapter) {
      adapter.on("event", (event) => {
        if (event.type === "transcript" && event.text) {
          const elapsed = Date.now() - startedAt;
          if (firstResultMs === null) firstResultMs = elapsed;
          if (event.final && finalResultMs === null) finalResultMs = elapsed;
        }
        send(ws, event);
      });
      adapter.on("error", () => {
        if (ended) return;
        send(ws, { type: "error", error: { message: "Realtime provider error", type: "provider_error", code: "upstream_provider_error", request_id: requestId } });
        void finish("error", "upstream_provider_error", true);
      });
      adapter.on("close", () => {
        if (ended) return;
        send(ws, { type: "error", error: { message: "Realtime provider disconnected", type: "provider_error", code: "upstream_disconnected", request_id: requestId } });
        void finish("error", "upstream_disconnected", true);
      });
    }

    async function establish(value) {
      config = normalizeClientConfig(value);
      route = resolveSttRoute({ ...config, mode: "realtime" });
      credential = await getProviderCredential(route.provider, { runtime: true });
      if (!credential) {
        throw new SttError(`No server-side credentials are configured for ${route.provider}`, {
          status: 503, code: "provider_unavailable", type: "provider_error", provider: route.provider,
        });
      }
      provider = createRealtimeProvider({ ...route, requestId, token: credential.token, sampleRate: config.sampleRate, encoding: config.encoding });
      bindProvider(provider);
      await provider.connect();
      send(ws, { type: "session_started", provider: route.provider, model: route.model, request_id: requestId });
    }

    async function processMessage(data, isBinary) {
      if (ended) return;
      lastActivity = Date.now();
      if (!config) {
        if (isBinary) throw new SttError("Session configuration must be sent before audio", { status: 400, code: "missing_session_config" });
        if (data.length > 8_192) throw new SttError("Session configuration is too large", { status: 400, code: "invalid_session_config" });
        let value;
        try { value = JSON.parse(data.toString()); } catch { throw new SttError("Malformed session configuration", { status: 400, code: "invalid_session_config" }); }
        await establish(value);
        return;
      }
      if (!isBinary) {
        let control;
        try { control = JSON.parse(data.toString()); } catch { throw new SttError("Malformed realtime control message", { status: 400, code: "malformed_message" }); }
        if (control.type === "finalize") {
          provider.finalize?.();
          return;
        }
        if (control.type === "end") {
          send(ws, { type: "session_ended", provider: route.provider, model: route.model, request_id: requestId });
          await finish("ok", null, true);
          return;
        }
        throw new SttError("Unsupported realtime control message", { status: 400, code: "malformed_message" });
      }
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!frame.length) throw new SttError("Audio frame must not be empty", { status: 400, code: "empty_audio" });
      if (frame.length > maxFrameBytes) throw new SttError("Audio frame exceeds the configured limit", { status: 400, code: "audio_frame_too_large" });
      provider.sendAudio(frame);
      audioSeconds += audioSecondsForFrame(frame, config);
    }

    ws.on("message", (data, isBinary) => {
      sequence = sequence.then(() => processMessage(data, isBinary)).catch((error) => {
        const code = error instanceof SttError ? error.code : "realtime_session_failed";
        const message = error instanceof SttError ? error.message : "Realtime session failed";
        sendError(code, message, error instanceof SttError ? error.type : "provider_error");
        return finish("error", code, true);
      });
    });
    ws.on("close", () => { void finish(ended ? "ok" : "aborted", ended ? null : "client_disconnected", false); });
    ws.on("error", () => { void finish("aborted", "client_socket_error", false); });
  });

  return async function handleUpgrade(request, socket, head) {
    if (activeConnections >= maxConnections) return writeUpgradeFailure(socket, 503, "Service Unavailable");
    const auth = await authenticateGatewayRequest(request.headers, { isLoopback: isTrustedLoopbackRequest(request.headers), runtime: true });
    if (!auth.ok) return writeUpgradeFailure(socket, 401, "Unauthorized");
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };
}

export function attachRealtimeGateway(server) {
  const handlerPromise = Promise.resolve(createRealtimeUpgradeHandler());
  server.on("upgrade", (request, socket, head) => {
    if (!isRealtimePath(request)) return;
    void handlerPromise.then((handler) => handler(request, socket, head)).catch((error) => {
      console.warn(`[stt] realtime upgrade failed: ${error?.message || "unknown error"}`);
      writeUpgradeFailure(socket, 500, "Internal Server Error");
    });
  });
}
