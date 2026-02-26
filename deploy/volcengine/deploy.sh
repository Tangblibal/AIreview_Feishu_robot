#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/qjgroup-ai-review}"
SERVICE_NAME="${SERVICE_NAME:-lumo-review}"
BRANCH="${BRANCH:-main}"

if ! command -v git >/dev/null 2>&1; then
  echo "git not found" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found" >&2
  exit 1
fi

if [ ! -d "${APP_DIR}" ]; then
  echo "APP_DIR does not exist: ${APP_DIR}" >&2
  exit 1
fi

echo "[deploy] app_dir=${APP_DIR} branch=${BRANCH} service=${SERVICE_NAME}"

cd "${APP_DIR}"
git fetch --all --prune
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"
npm ci --omit=dev

sudo systemctl daemon-reload
sudo systemctl restart "${SERVICE_NAME}"
sudo systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,40p'

echo "[deploy] done"
