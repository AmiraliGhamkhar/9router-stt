import WebSocket from "ws";
import { SttError } from "../../error.js";
import { RealtimeProvider } from "../realtimeBase.js";

const ENDPOINT = "wss://eu.rt.speechmatics.com/v2";
const CONNECT_TIMEOUT_MS = 15_000;

export class SpeechmaticsRealtimeProvider extends RealtimeProvider {
  async connect() {
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
        finish(reject, new SttError("Speechmatics realtime connection timed out", {
          status: 504, code: "upstream_timeout", type: "provider_error", provider: "speechmatics",
        }));
      }, CONNECT_TIMEOUT_MS);
      this.socket = new WebSocket(process.env.SPEECHMATICS_REALTIME_URL || ENDPOINT, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      this.socket.on("open", () => {
        this.socket.send(JSON.stringify({
          message: "StartRecognition",
          audio_format: {
            type: "raw",
            encoding: this.encoding,
            sample_rate: this.sampleRate,
          },
          transcription_config: {
            language: this.language,
            model: this.model,
            enable_partials: true,
          },
        }));
      });
      this.socket.on("message", (data) => this.handleMessage(data, { resolve, reject, finish }));
      this.socket.on("error", () => finish(reject, new SttError("Speechmatics realtime connection failed", {
        status: 502, code: "upstream_connection_failed", type: "provider_error", provider: "speechmatics",
      })));
      this.socket.on("close", (code) => {
        if (!this.closed && settled) this.emit("close", { code });
      });
    });
  }

  handleMessage(data, pending) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.message === "RecognitionStarted") {
      this.ready = true;
      pending?.finish?.(pending.resolve);
      return;
    }
    if (message.message === "AddPartialTranscript" || message.message === "AddTranscript") {
      const first = message.results?.[0];
      const firstContent = first?.alternatives?.[0] || {};
      const text = message.metadata?.transcript;
      if (!text) return;
      this.emit("event", this.normalizedTranscript({
        text,
        final: message.message === "AddTranscript",
        startTime: message.metadata?.start_time,
        endTime: message.metadata?.end_time,
        confidence: typeof firstContent.confidence === "number" ? firstContent.confidence : undefined,
        language: firstContent.language,
        speaker: firstContent.speaker,
      }));
      return;
    }
    if (message.message === "Error") {
      const error = new SttError("Speechmatics realtime provider error", {
        status: 502,
        code: message.type === "not_authorised" ? "upstream_authentication_failed" : "upstream_provider_error",
        type: "provider_error",
        provider: "speechmatics",
      });
      if (pending?.finish) pending.finish(pending.reject, error);
      else this.emit("error", error);
    }
  }

  sendAudio(audio) {
    if (!audio?.length) throw new SttError("Audio frame must not be empty", { status: 400, code: "empty_audio" });
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) throw new SttError("Speechmatics realtime session is not connected", {
      status: 502, code: "upstream_disconnected", type: "provider_error", provider: "speechmatics",
    });
    this.socket.send(audio, { binary: true });
  }

  finalize() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ message: "EndOfStream" }));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    try {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ message: "EndOfStream" }));
      this.socket.close(1000);
    } catch {
      try { this.socket.terminate(); } catch {}
    }
  }
}
