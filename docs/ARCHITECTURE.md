# 9router-stt architecture

`9router-stt` is a provider-independent speech-to-text gateway. Clients send a
gateway API key and a common STT request; provider credentials and wire
protocols remain server-side.

```text
Client
  │ Authorization: Bearer <gateway key>
  ▼
9router-stt
  ├── authentication and limits
  ├── deterministic router
  ├── normalized batch HTTP API
  ├── normalized realtime WebSocket API
  ├── privacy-safe usage telemetry
  └── trusted provider adapters
      ├── Speechmatics batch + realtime
      └── Deepgram batch + realtime
```

## Runtime topology

The normal production process is a long-running Node.js server. Next.js serves
the HTTP application and dashboard, while `custom-server.js` attaches the
WebSocket gateway to the same HTTP server. This keeps a realtime session and
its upstream provider socket in one process with explicit cleanup.

```text
HTTP /v1/audio/transcriptions ─┐
HTTP /v1/models/stt            ├─ Next.js + middleware ─ provider-independent STT
HTTP /health                   ┘
WS   /v1/realtime                 custom-server.js ─ provider WebSocket
```

Batch remains compatible with a Next.js deployment, but continuous realtime
sessions should use the Docker/Node deployment rather than a serverless-only
runtime. Vercel's current WebSocket support is bounded by function duration;
the gateway therefore does not depend on it for indefinite audio sessions.

## Source layout

```text
src/stt/
├── auth.js                 gateway key validation and loopback proof
├── batchGateway.js         multipart validation, routing, normalization, usage
├── credentials.js          environment/database provider credentials
├── error.js                public error model and upstream sanitization
├── realtimeGateway.js      WebSocket lifecycle and normalized events
├── requestId.js            stt_ request/session IDs
├── routing.js              deterministic model/provider routing
├── runtimeDb.js            DB access for the standalone WebSocket process
├── usage.js                operational usage metadata
└── providers/
    ├── batch.js            common batch provider dispatch
    ├── realtime.js         common realtime provider dispatch
    ├── realtimeBase.js     adapter contract and event normalization
    ├── common.js           MIME, fetch timeout, response helpers
    ├── deepgram/
    │   ├── batch.js
    │   └── realtime.js
    └── speechmatics/
        ├── batch.js
        └── realtime.js
```

The public Next routes are intentionally thin:

* `src/app/api/v1/audio/transcriptions/route.js`
* `src/app/api/v1/models/stt/route.js`
* `src/app/api/v1/health/route.js`

`/v1/*` and `/health` are rewrites in `next.config.mjs`. `custom-server.js`
handles WebSocket upgrades because an App Router route is not a reliable owner
for a long-lived socket.

## Request flow

### Batch

1. Middleware and the route validate the gateway key.
2. The multipart body is parsed with a bounded upload size; empty files are
   rejected.
3. `routing.js` parses provider-qualified models, aliases, language, profile,
   and mode. Only known providers/models can be selected.
4. `credentials.js` chooses an environment credential first, then an active
   connection from the existing provider-connections database.
5. The adapter calls the official provider API and translates its response.
6. The gateway returns the common response and records operational metadata.

Speechmatics jobs are asynchronous and use bounded status polling. Deepgram
uses its existing raw-audio `POST /v1/listen` contract. Neither adapter returns
raw provider envelopes to clients.

### Realtime

1. The WebSocket upgrade is authenticated before any upstream connection is
   created.
2. The first client message must be JSON session configuration. Binary frames
   are rejected before configuration and are size-limited afterward.
3. The deterministic router selects one provider for the complete session.
4. The provider adapter connects, sends its provider-specific start message,
   and emits `session_started` after the upstream handshake is ready.
5. Binary audio is forwarded without buffering the full session.
6. Provider messages become normalized `transcript` events.
7. Client close, upstream close, timeout, malformed input, and provider errors
   all close the upstream adapter and record the session once.

There is no mid-session failover. A provider failure produces one normalized
error and a clean close; the client must reconnect and receive a new route.

## Adapter contract

Every realtime adapter implements:

```text
connect() -> Promise<void>
sendAudio(Buffer) -> void
receiveEvents(listener) -> unsubscribe function
close() -> Promise<void>
```

Adapters may emit `event`, `error`, and `close` internally, but provider wire
messages never cross the gateway boundary. Normalized transcript events contain
`type`, `final`, `text`, `provider`, `model`, and `request_id`; timing,
confidence, language, speaker, and `speech_final` are copied only when the
provider supplies them.

Batch adapters implement:

```text
transcribe(request) -> { text, audioSeconds?, metadata?, segments? }
```

## Routing

Routing is deterministic and configuration-driven. The supported request
values are `speechmatics`, `deepgram`, and `auto`. A provider prefix in a model
(`speechmatics/enhanced`) is authoritative and cannot conflict with an
explicit provider. `auto` considers mode, language, and profile using
`STT_ROUTING_JSON`; the built-in routes send medical Farsi to Speechmatics and
general English to Deepgram.

Aliases are configured with `STT_MODEL_ALIASES_JSON`. No LLM, embeddings,
vector store, cost scorer, or arbitrary upstream URL is involved in routing.

## Authentication and credentials

* `STT_GATEWAY_API_KEY` is the deployment-level client key.
* Existing active dashboard API keys remain valid through the existing database
  infrastructure.
* `SPEECHMATICS_API_KEY` and `DEEPGRAM_API_KEY` are read only on the server.
* A client can select a trusted provider/model, but cannot select an upstream
  URL or send a provider credential.
* STT routes require authentication remotely. The explicit
  `STT_ALLOW_INSECURE_LOCAL=true` escape hatch is loopback-only and intended for
  a built local server in development.
* Middleware continues to protect dashboard and administrative routes; STT
  authentication is a separate allow-list and does not unlock the LLM API.

## Privacy and usage

Audio is kept in request/session memory and is not written to disk by the STT
gateway. Logs contain request ID, provider, model, mode, language, latency,
status, and error code. Authorization headers, provider keys, audio, and
transcript text are not logged by default.

The existing usage database stores request ID, provider, model, mode, language,
audio seconds when known, connection duration/latency, time to first/final
result, status, and error code in metadata. It does not store transcript text
as usage metadata.

## Deployment

```bash
cp .env.example .env
npm install
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
```

For production realtime workloads:

```bash
cp .env.example .env
# configure gateway/provider secrets
docker compose up --build -d
```

The image listens on configurable `PORT`, binds to `0.0.0.0`, includes HTTP
and WebSocket handling, and persists only the explicitly configured data
volume.

## Existing repository infrastructure

The repository still contains the original dashboard, database, provider
registry, `open-sse`, and legacy media/LLM routes. They were audited rather
than blindly deleted: the dashboard and secure provider-connection database
are reused by STT, existing public APIs remain available for compatibility,
and the old STT handler is still referenced by its provider-contract tests and
registry integrations. New gateway traffic has one implementation path under
`src/stt`; it does not route through the legacy LLM switch.
