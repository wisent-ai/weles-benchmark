#!/bin/sh
set -eu

root="$HOME/.stado/skyvern-benchmark"
brama_token_file="$HOME/.stado/weles-benchmark-brama-token"
skyvern_token_file="$HOME/.stado/weles-benchmark-skyvern-token"
mkdir -p "$root"

if [ ! -r "$brama_token_file" ]; then
  printf 'missing Brama token file: %s\n' "$brama_token_file" >&2
  exit 1
fi

cat >"$root/compose.yml" <<'YAML'
name: weles-benchmark-skyvern
services:
  postgres:
    image: postgres:14-alpine
    restart: unless-stopped
    volumes:
      - ./postgres-data:/var/lib/postgresql/data
    environment:
      PGDATA: /var/lib/postgresql/data/pgdata
      POSTGRES_USER: skyvern
      POSTGRES_PASSWORD: skyvern
      POSTGRES_DB: skyvern
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U skyvern"]
      interval: 5s
      timeout: 5s
      retries: 12
  skyvern:
    image: public.ecr.aws/skyvern/skyvern:v1.0.48
    restart: unless-stopped
    extra_hosts:
      - host.docker.internal:host-gateway
    env_file:
      - .env
    ports:
      - 127.0.0.1:18000:8000
    volumes:
      - ./artifacts:/data/artifacts
      - ./videos:/data/videos
      - ./har:/data/har
      - ./log:/data/log
      - ./downloads:/data/downloads
      - ./browser-sessions:/data/browser_sessions
      - ./credential-vault:/data/credential_vault
      - ./.skyvern:/app/.skyvern
    environment:
      DATABASE_STRING: postgresql+psycopg://skyvern:skyvern@postgres:5432/skyvern
      BROWSER_TYPE: chromium-headless
      BROWSER_STREAMING_MODE: cdp
      DOWNLOAD_PATH: /data/downloads
      BROWSER_SESSION_BASE_PATH: /data/browser_sessions
      CREDENTIAL_VAULT_TYPE: skyvern
      ENABLE_LOCAL_CREDENTIAL_VAULT: "true"
      LOCAL_CREDENTIAL_VAULT_PATH: /data/credential_vault
      ENABLE_CODE_BLOCK: "true"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/heartbeat', timeout=5)"]
      interval: 5s
      timeout: 5s
      retries: 36
      start_period: 180s
YAML

umask 077
{
  printf 'ENABLE_OPENAI=true\n'
  printf 'OPENAI_API_KEY=%s\n' "$(cat "$brama_token_file")"
  printf 'OPENAI_API_BASE=https://brama.wisent.com/v1\n'
  printf 'LLM_KEY=OPENAI_GPT5_4\n'
  printf 'MAX_STEPS_PER_RUN=20\n'
  printf 'LOG_LEVEL=INFO\n'
} >"$root/.env"

cd "$root"
docker compose -f compose.yml up -d --wait postgres skyvern
credential_file="$root/.skyvern/credentials.toml"
credential=''
if [ -r "$credential_file" ]; then
  credential=$(awk 'match($0, /cred="[^"]+"/) { print substr($0, RSTART + 6, RLENGTH - 7); exit }' "$credential_file")
fi
if [ -z "$credential" ]; then
  printf 'Skyvern started without generating an API credential\n' >&2
  exit 1
fi
printf '%s\n' "$credential" >"$skyvern_token_file"
printf 'Skyvern benchmark API ready at http://127.0.0.1:18000\n'
