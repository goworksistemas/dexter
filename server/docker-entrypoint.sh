#!/bin/sh
set -eu

INFISICAL_API_URL="${INFISICAL_API_URL:-https://vault.gowork.com.br}"
INFISICAL_ENV="${INFISICAL_ENV:-prod}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-578a6937-020f-4d07-9eb7-474c6bec3c0a}"
INFISICAL_PATH="${INFISICAL_SECRET_PATH:-/}"

if [ -z "${INFISICAL_TOKEN:-}" ]; then
  if [ -n "${INFISICAL_MACHINE_CLIENT_ID:-}" ] && [ -n "${INFISICAL_MACHINE_CLIENT_SECRET:-}" ]; then
    INFISICAL_TOKEN="$(
      infisical login \
        --method=universal-auth \
        --client-id="$INFISICAL_MACHINE_CLIENT_ID" \
        --client-secret="$INFISICAL_MACHINE_CLIENT_SECRET" \
        --domain="$INFISICAL_API_URL" \
        --plain --silent
    )"
    export INFISICAL_TOKEN
  else
    echo "Defina INFISICAL_TOKEN ou INFISICAL_MACHINE_CLIENT_ID + INFISICAL_MACHINE_CLIENT_SECRET" >&2
    exit 1
  fi
fi

exec infisical run \
  --token="$INFISICAL_TOKEN" \
  --domain="$INFISICAL_API_URL" \
  --env="$INFISICAL_ENV" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --path="$INFISICAL_PATH" \
  -- pnpm start
