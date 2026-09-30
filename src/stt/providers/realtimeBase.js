import { EventEmitter } from "node:events";

/**
 * Small common realtime contract:
 *   connect() -> Promise<void>
 *   sendAudio(Buffer) -> void
 *   close() -> Promise<void>
 *
 * Instances emit normalized `event`, `error`, and `close` events. Provider
 * wire messages never leave these adapters.
 */
export class RealtimeProvider extends EventEmitter {
  constructor({ provider, model, language, requestId, token, sampleRate, encoding }) {
    super();
    this.provider = provider;
    this.model = model;
    this.language = language;
    this.requestId = requestId;
    this.token = token;
    this.sampleRate = sampleRate;
    this.encoding = encoding;
    this.closed = false;
  }

  normalizedTranscript({ text, final, startTime, endTime, confidence, language, speaker, speechFinal }) {
    const event = {
      type: "transcript",
      final: Boolean(final),
      text,
      provider: this.provider,
      model: this.model,
      request_id: this.requestId,
    };
    if (typeof startTime === "number") event.start_time = startTime;
    if (typeof endTime === "number") event.end_time = endTime;
    if (typeof confidence === "number") event.confidence = confidence;
    if (language) event.language = language;
    if (speaker !== undefined && speaker !== null) event.speaker = speaker;
    if (typeof speechFinal === "boolean") event.speech_final = speechFinal;
    return event;
  }
}
