import { afterEach, describe, expect, it } from "vitest";
import { isTrustedLoopbackRequest } from "../../src/stt/auth.js";
import { transcribeDeepgram } from "../../src/stt/providers/deepgram/batch.js";
import { transcribeSpeechmatics } from "../../src/stt/providers/speechmatics/batch.js";
import { DeepgramRealtimeProvider } from "../../src/stt/providers/deepgram/realtime.js";
import { SpeechmaticsRealtimeProvider } from "../../src/stt/providers/speechmatics/realtime.js";
import { resolveSttRoute } from "../../src/stt/routing.js";

const audio = new File([new Uint8Array([0, 1, 2, 3])], "sample.wav", { type: "audio/wav" });
const initialPeerToken = process.env.NINEROUTER_PEER_TOKEN;

afterEach(() => {
  if (initialPeerToken === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
  else process.env.NINEROUTER_PEER_TOKEN = initialPeerToken;
});

describe("trusted loopback detection", () => {
  it("requires the custom server peer proof instead of trusting Host", () => {
    process.env.NINEROUTER_PEER_TOKEN = "test-peer-token";

    expect(isTrustedLoopbackRequest(new Headers({ host: "localhost", "x-9r-real-ip": "127.0.0.1" }))).toBe(false);
    expect(isTrustedLoopbackRequest(new Headers({ "x-9r-peer-token": "forged", "x-9r-real-ip": "127.0.0.1" }))).toBe(false);
    expect(isTrustedLoopbackRequest(new Headers({ "x-9r-peer-token": "test-peer-token", "x-9r-real-ip": "10.0.0.4" }))).toBe(false);
    expect(isTrustedLoopbackRequest(new Headers({ "x-9r-peer-token": "test-peer-token", "x-9r-real-ip": "::1" }))).toBe(true);
    expect(isTrustedLoopbackRequest(new Headers({ "x-stt-local-proof": "test-peer-token" }))).toBe(true);
  });
});

function realtimeContract(Adapter, provider) {
  it(`${provider} implements the shared realtime adapter contract`, () => {
    for (const method of ["connect", "sendAudio", "receiveEvents", "close"]) {
      expect(typeof Adapter.prototype[method]).toBe("function");
    }
  });
}

describe("deterministic STT router", () => {
  it("uses the configured built-in medical Farsi auto route", () => {
    expect(resolveSttRoute({ provider: "auto", model: "enhanced", language: "fa", profile: "medical", mode: "realtime" }))
      .toMatchObject({ provider: "speechmatics", model: "enhanced" });
  });

  it("uses a provider-qualified model deterministically", () => {
    expect(resolveSttRoute({ provider: "auto", model: "deepgram/nova-3", language: "en", mode: "batch" }))
      .toMatchObject({ provider: "deepgram", model: "nova-3" });
  });

  it("rejects a mismatched explicit provider and model", () => {
    expect(() => resolveSttRoute({ provider: "speechmatics", model: "deepgram/nova-3", language: "en", mode: "batch" }))
      .toThrow(/conflicts/i);
  });
});

describe("batch adapter contract", () => {
  it("normalizes Deepgram prerecorded output without returning raw provider output", async () => {
    const result = await transcribeDeepgram({
      file: audio, model: "nova-3", language: "en", token: "secret", verbose: true,
      fetchImpl: async () => new Response(JSON.stringify({
        metadata: { duration: 1.5, request_id: "dg-request" },
        results: { channels: [{ alternatives: [{ transcript: "hello world", words: [{ word: "hello", start: 0, end: 0.5, confidence: 0.9 }] }] }] },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    expect(result).toMatchObject({ text: "hello world", audioSeconds: 1.5, metadata: { duration: 1.5 } });
    expect(result.segments).toEqual([expect.objectContaining({ text: "hello", start_time: 0, end_time: 0.5 })]);
  });

  it("submits and normalizes a Speechmatics async job", async () => {
    const replies = [
      new Response(JSON.stringify({ id: "job-1" }), { status: 201 }),
      new Response(JSON.stringify({ job: { status: "done", duration: 2 } }), { status: 200 }),
      new Response(JSON.stringify({ job: { id: "job-1", duration: 2 }, results: [
        { type: "word", alternatives: [{ content: "hello", confidence: 0.9 }] },
        { type: "punctuation", attaches_to: "previous", alternatives: [{ content: ".", confidence: 1 }] },
      ] }), { status: 200 }),
    ];
    const result = await transcribeSpeechmatics({
      file: audio, model: "enhanced", language: "en", token: "secret", verbose: true,
      fetchImpl: async () => replies.shift(), timeoutMs: 50,
    });
    expect(result).toMatchObject({ text: "hello.", audioSeconds: 2, metadata: { id: "job-1" } });
  });
});

describe("realtime event normalization", () => {
  realtimeContract(DeepgramRealtimeProvider, "Deepgram");
  realtimeContract(SpeechmaticsRealtimeProvider, "Speechmatics");

  it("normalizes a Deepgram final result", () => {
    const adapter = new DeepgramRealtimeProvider({ provider: "deepgram", model: "nova-3", language: "en", requestId: "stt_test", token: "secret", sampleRate: 16000, encoding: "pcm_s16le" });
    const events = [];
    adapter.on("event", (event) => events.push(event));
    adapter.handleMessage(Buffer.from(JSON.stringify({
      type: "Results", is_final: true, speech_final: true, start: 0, duration: 1,
      channel: { alternatives: [{ transcript: "hello", confidence: 0.97, languages: ["en"] }] },
    })));
    expect(events).toEqual([expect.objectContaining({ type: "transcript", text: "hello", final: true, speech_final: true, request_id: "stt_test" })]);
  });

  it("normalizes a Speechmatics partial transcript", () => {
    const adapter = new SpeechmaticsRealtimeProvider({ provider: "speechmatics", model: "enhanced", language: "fa", requestId: "stt_test", token: "secret", sampleRate: 16000, encoding: "pcm_s16le" });
    const events = [];
    adapter.on("event", (event) => events.push(event));
    adapter.handleMessage(Buffer.from(JSON.stringify({
      message: "AddPartialTranscript",
      metadata: { transcript: "متن", start_time: 0.1, end_time: 0.4 },
      results: [{ alternatives: [{ confidence: 0.92, language: "fa" }] }],
    })));
    expect(events).toEqual([expect.objectContaining({ type: "transcript", text: "متن", final: false, language: "fa" })]);
  });

  it("forwards a post-handshake Speechmatics error to the gateway", () => {
    const adapter = new SpeechmaticsRealtimeProvider({ provider: "speechmatics", model: "enhanced", language: "en", requestId: "stt_test", token: "secret", sampleRate: 16000, encoding: "pcm_s16le" });
    adapter.ready = true;
    const errors = [];
    adapter.on("error", (error) => errors.push(error));
    adapter.handleMessage(Buffer.from(JSON.stringify({ message: "Error", type: "not_authorised" })));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "upstream_authentication_failed", provider: "speechmatics" });
  });
});
