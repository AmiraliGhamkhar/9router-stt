# Docker deployment

`9router-stt` is a Node.js service that exposes the HTTP batch API and the
long-lived realtime WebSocket API from the same container. It does not require
Python, local speech software, Redis, or provider SDKs.

## Run with Docker Compose

```bash
cp .env.example .env
# Set STT_GATEWAY_API_KEY and at least one provider key in .env
docker compose up --build -d
curl http://localhost:20128/health
```

The compose file publishes port `20128`, binds the service to `0.0.0.0`, and
persists only the existing SQLite metadata/usage database in the
`9router-stt-data` volume. Uploaded audio is held for the request and is not
written to that volume.

## Run the image directly

```bash
docker build -t 9router-stt:local .
docker run --rm \
  --name 9router-stt \
  -p 20128:20128 \
  -v 9router-stt-data:/app/data \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e STT_GATEWAY_API_KEY="$STT_GATEWAY_API_KEY" \
  -e SPEECHMATICS_API_KEY="$SPEECHMATICS_API_KEY" \
  -e DEEPGRAM_API_KEY="$DEEPGRAM_API_KEY" \
  9router-stt:local
```

Prefer an environment file or a platform secret store for production instead
of putting credentials in a shell history. Provider credentials stay inside
the container and are never returned to clients.

## Production notes

* Put the service behind a reverse proxy that supports WebSocket upgrades for
  `/v1/realtime`.
* Configure a long random `STT_GATEWAY_API_KEY` for remote clients.
* Set `DATA_DIR=/app/data` on the persistent volume if the default volume path
  is changed.
* Keep `STT_ALLOW_INSECURE_LOCAL` unset in production.
* `/health` is a lightweight liveness check and does not make provider calls.

See the root [README](README.md) for batch/realtime API examples, deterministic
routing, environment variables, privacy behavior, and the provider protocol
links used by the adapters.
