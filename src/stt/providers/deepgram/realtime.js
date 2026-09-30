import WebSocket from "ws";
import { SttError } from "../../error.js";
import { RealtimeProvider } from "../realtimeBase.js";

const ENDPOINT = "wss://api.deepgram.com/v1/listen";
const CONNECT_TIMEOUT_MS = 15_000;

function deepgramEncoding(encoding) {
  if (encoding === "pcm_s16le") return "linear16";
  if (encoding === "mulaw") return "mulaw";
  return encoding;
}

export class DeepgramRealtimeProvider extends RealtimeProvider {
  async connect() {
    const url = new URL(process.env.DEEPGRAM_REALTIME_URL || ENDPOINT);
    url.searchParams.set("model", this.model);
    url.searchParams.set("language", this.language);
    url.searchParams.set("encoding", deepgramEncoding(this.encoding));
    url.searchParams.set("sample_rate", String(this.sampleRate));
    url.searchParams.set("channels", "1");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("endpointing", process.env.DEEPGRAM_ENDPOINTING_MS || "300");
    url.searchParams.set("vad_events", "true");

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn(value);
      };
      const timeout = setTimeout(() => {
        try { this.socket?.terminate(); } catch {}
        finish(reject, new SttError("Deepgram realtime connection timed out", {
          status: 504, code: "upstream_timeout", type: "provider_error", provider: "deepgram",
        }));
      }, CONNECT_TIMEOUT_MS);
      this.socket = new WebSocket(url, { headers: { Authorization: `Token ${this.token}` } });
      this.socket.on("open", () => finish(resolve));
      this.socket.on("error", () => finish(reject, new SttError("Deepgram realtime connection failed", {
        status: 502, code: "upstream_connection_failed", type: "provider_error", provider: "deepgram",
      })));
      this.socket.on("message", (data) => this.handleMessage(data));
      this.socket.on("close", (code) => {
        this.clearKeepAlive();
        if (!this.closed) this.emit("close", { code });
      });
    });
    this.keepAlive = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5_000);
    this.keepAlive.unref?.();
  }

  handleMessage(data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === "Results") {
      const alternative = message.channel?.alternatives?.[0];
      const text = alternative?.transcript?.trim();
      if (!text) return;
      const language = Array.isArray(alternative.languages) ? alternative.languages[0] : undefined;
      this.emit("event", this.normalizedTranscript({
        text,
        final: message.is_final,
        startTime: typeof message.start === "number" ? message.start : undefined,
        endTime: typeof message.start === "number" && typeof message.duration === "number" ? message.start + message.duration : undefined,
        confidence: typeof alternative.confidence === "number" ? alternative.confidence : undefined,
        language,
        speechFinal: typeof message.speech_final === "boolean" ? message.speech_final : undefined,
      }));
    } else if (message.type === "Error") {
      this.emit("error", new SttError("Deepgram realtime provider error", {
        status: 502, code: "upstream_provider_error", type: "provider_error", provider: "deepgram",
      }));
    }
  }

  sendAudio(audio) {
    if (!audio?.length) throw new SttError("Audio frame must not be empty", { status: 400, code: "empty_audio" });
    if (this.socket?.readyState !== WebSocket.OPEN) throw new SttError("Deepgram realtime session is not connected", {
      status: 502, code: "upstream_disconnected", type: "provider_error", provider: "deepgram",
    });
    this.socket.send(audio, { binary: true });
  }

  finalize() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "Finalize" }));
  }

  clearKeepAlive() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.clearKeepAlive();
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    try {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "CloseStream" }));
      this.socket.close(1000);
    } catch {
      try { this.socket.terminate(); } catch {}
    }
  }
}
