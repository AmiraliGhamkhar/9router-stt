# 9router-stt

A production-oriented, provider-independent speech-to-text gateway. Client
applications use one API while 9router-stt keeps Speechmatics and Deepgram
credentials on the server.

```text
client ── gateway API key ──> 9router-stt ──> Speechmatics / Deepgram
                                  ├─ batch HTTP
                                  ├─ realtime WebSocket
                                  ├─ deterministic routing
                                  └─ privacy-safe usage telemetry
```

## Quick start

```bash
cp .env.example .env
# Set STT_GATEWAY_API_KEY and at least one provider key in .env
npm install
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
```

The production process listens on `0.0.0.0` and serves HTTP and WebSocket
traffic from the same port. `/health` is an unauthenticated liveness endpoint;
it does not call a provider.

## Authentication

Every remote STT operation needs a gateway key:

```http
Authorization: Bearer <STT_GATEWAY_API_KEY>
```

Active API keys in the existing dashboard database are also accepted, so an
installation can centrally manage client keys without putting a provider key in
a client. `SPEECHMATICS_API_KEY` and `DEEPGRAM_API_KEY` are never returned by
any gateway endpoint. `STT_ALLOW_INSECURE_LOCAL=true` is an explicitly
**development-only** direct-loopback escape hatch. It requires the peer-aware
custom server running with `NODE_ENV=development`, which stamps an internal
proof only after verifying a direct TCP loopback peer; a request through a
proxy never receives that proof. The production server never creates that
proof. For isolated local development, after a production build start the custom server
with `NODE_ENV=development STT_ALLOW_INSECURE_LOCAL=true npm run start`. Do not
set this flag in production; remote requests remain key-authenticated.

## Batch transcription

`POST /v1/audio/transcriptions` accepts standard multipart form data:

```bash
curl -X POST http://localhost:20128/v1/audio/transcriptions \
  -H "Authorization: Bearer $STT_GATEWAY_API_KEY" \
  -F file=@consultation.wav \
  -F model=speechmatics/enhanced \
  -F language=fa \
  -F provider=speechmatics
```

`file`, `model`, and `language` are required. `provider` may be `speechmatics`,
`deepgram`, or `auto`; optional fields are `profile`, `prompt`,
`response_format`, and `temperature`. `prompt` and `temperature` are accepted
for OpenAI-compatible client compatibility but are intentionally not used by
the deterministic v1 adapters. Use `response_format=verbose_json` to
receive real provider-supplied timing/confidence metadata where available.

A successful response always preserves the OpenAI-compatible `text` field and
adds routing metadata:

```json
{
  "text": "...",
  "provider": "speechmatics",
  "model": "enhanced",
  "request_id": "stt_..."
}
```

Uploads are held in memory for the request and are not persisted locally. The
default maximum upload is 25 MiB (`STT_MAX_UPLOAD_BYTES`).

## Realtime transcription

Connect to `WS /v1/realtime` with `Authorization: Bearer <gateway key>` and
send one JSON configuration frame before binary audio frames:

```json
{
  "provider": "auto",
  "model": "enhanced",
  "language": "fa",
  "profile": "medical",
  "sample_rate": 16000,
  "encoding": "pcm_s16le"
}
```

For browsers, which cannot attach an Authorization header during the standard
WebSocket handshake, use the WebSocket subprotocols `stt` and the gateway key:

```js
const socket = new WebSocket("wss://gateway.example/v1/realtime", ["stt", gatewayApiKey]);
socket.onopen = () => socket.send(JSON.stringify({
  provider: "auto", model: "enhanced", language: "fa", profile: "medical",
  sample_rate: 16000, encoding: "pcm_s16le"
}));
// socket.send(ArrayBuffer) for each PCM audio frame
```

The server emits only normalized events:

```json
{"type":"session_started","provider":"speechmatics","model":"enhanced","request_id":"stt_..."}
{"type":"transcript","final":false,"text":"...","provider":"speechmatics","model":"enhanced","request_id":"stt_..."}
{"type":"transcript","final":true,"text":"...","provider":"speechmatics","model":"enhanced","request_id":"stt_..."}
```

`{"type":"finalize"}` flushes a provider stream when supported and
`{"type":"end"}` ends it cleanly. Client disconnection always closes the
upstream socket; upstream failure emits a normalized `error` event and ends the
session instead of switching providers halfway through it.

## Providers

| Provider | Batch | Realtime | Models exposed by default |
| --- | --- | --- | --- |
| Speechmatics | Jobs API with bounded polling | Realtime `/v2` WebSocket | `enhanced`, `standard` |
| Deepgram | `POST /v1/listen` raw audio | Live `/v1/listen` WebSocket | `nova-3`, `nova-2` |

Provider protocol details stay inside `src/stt/providers`. The public endpoint
never accepts an upstream URL, so it cannot be used as an SSRF proxy. The
adapters follow the current official [Speechmatics batch](https://docs.speechmatics.com/speech-to-text/batch/input),
[Speechmatics realtime](https://docs.speechmatics.com/api-ref/realtime-transcription-websocket),
[Deepgram prerecorded](https://developers.deepgram.com/reference/speech-to-text/listen),
and [Deepgram streaming](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
protocols. The gateway proxies those upstream connections itself; it does not
mint or expose provider credentials to clients.

## Routing

Routing is deterministic; there is no LLM or scoring step.

* `provider=speechmatics` or `provider=deepgram` selects that trusted provider.
* A provider prefix in `model` (for example `deepgram/nova-3`) is also
  deterministic.
* `provider=auto` resolves `mode`, `language`, and `profile` through
  `STT_ROUTING_JSON`.

The built-in defaults send `fa + medical` (batch or realtime) to Speechmatics,
`en + general` to Deepgram, and use Deepgram as the explicit fallback route.
Set `STT_ROUTING_JSON` to replace the routes and
`STT_MODEL_ALIASES_JSON` to define aliases such as
`medical-fa -> speechmatics/enhanced`.

## Discovery and health

```bash
curl http://localhost:20128/health
curl http://localhost:20128/v1/health
curl -H "Authorization: Bearer $STT_GATEWAY_API_KEY" \
  http://localhost:20128/v1/models/stt
```

`GET /v1/models/stt` returns only STT models in an OpenAI-compatible list.
Existing `/v1/models` behaviour remains unchanged for legacy clients.

## Observability and privacy

Each batch request and realtime session receives one `stt_...` request ID.
The gateway writes operational metadata to the existing usage database:
provider, model, mode, language, latency, audio duration when known, first and
final result timing, status, and error code. It does **not** store audio or
transcript text in gateway logs or usage telemetry by default. Provider error
bodies, authorization headers, and credentials are intentionally not logged or
returned to clients.

## Docker deployment

```bash
cp .env.example .env
# edit .env with real gateway/provider keys
docker compose up --build -d
curl http://localhost:20128/health
```

The image uses Node.js only and persists only its database volume. For long-lived
realtime sessions, deploy the Docker/Node service behind a WebSocket-capable
reverse proxy. Vercel Functions support WebSockets only within function duration
limits; Docker is the recommended production deployment for continuous audio
sessions.

## Configuration reference

| Variable | Purpose |
| --- | --- |
| `STT_GATEWAY_API_KEY` | Required environment-backed client gateway key |
| `SPEECHMATICS_API_KEY` | Server-side Speechmatics key |
| `DEEPGRAM_API_KEY` | Server-side Deepgram key |
| `STT_ROUTING_JSON` | Optional deterministic routes JSON |
| `STT_MODEL_ALIASES_JSON` | Optional configured model aliases JSON |
| `STT_MAX_UPLOAD_BYTES` | Batch upload limit, default 25 MiB |
| `STT_BATCH_REQUEST_TIMEOUT_MS` | Per-request provider HTTP timeout, default 30 seconds |
| `STT_REALTIME_MAX_CONNECTIONS` | Concurrent realtime session cap |
| `STT_REALTIME_MAX_FRAME_BYTES` | Binary frame size cap |
| `STT_REALTIME_IDLE_MS` | Idle realtime timeout |
| `DATA_DIR`, `PORT`, `HOSTNAME`, `NODE_ENV` | Standard service runtime configuration |
