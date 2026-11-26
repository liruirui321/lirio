#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${LIRIO_DEPLOY_HOST:-annealingtech}"
REMOTE_DIR="/opt/lirio/app"

echo "==> Syncing server/ and website/ to ${REMOTE_HOST}:${REMOTE_DIR} ..."
rsync -avz --delete \
  --exclude 'lirio.db*' \
  --exclude '.env*' \
  --exclude 'test.mjs' \
  "${ROOT_DIR}/server/" "${REMOTE_HOST}:${REMOTE_DIR}/server/"

rsync -avz --delete \
  "${ROOT_DIR}/website/" "${REMOTE_HOST}:${REMOTE_DIR}/website/"

echo "==> Restarting lirio.service ..."
ssh "${REMOTE_HOST}" 'sudo systemctl restart lirio && sleep 1 && systemctl is-active lirio'

echo "==> Smoke checking public endpoints ..."
curl -fsS -o /dev/null -w "https://lirio.deltae.tech/site/ -> %{http_code}\n" https://lirio.deltae.tech/site/
curl -fsS -o /dev/null -w "https://lirio.deltae.tech/api/store/config -> %{http_code}\n" https://lirio.deltae.tech/api/store/config
