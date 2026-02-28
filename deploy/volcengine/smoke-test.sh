#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://app.qjgroup.top}"
AUDIO_FILE="${AUDIO_FILE:-}"
POLL_SECONDS="${POLL_SECONDS:-5}"
POLL_MAX="${POLL_MAX:-36}"

echo "[smoke] health check: ${BASE_URL}/api/health"
curl -fsS -i "${BASE_URL}/api/health"
echo

if [ -z "${AUDIO_FILE}" ]; then
  echo "[smoke] skip review flow, AUDIO_FILE is empty"
  exit 0
fi
if [ ! -f "${AUDIO_FILE}" ]; then
  echo "[smoke] audio file not found: ${AUDIO_FILE}" >&2
  exit 1
fi

echo "[smoke] submit review job"
submit_response="$(curl -fsS -X POST "${BASE_URL}/api/review" -F "audio=@${AUDIO_FILE}" -F "templates=[]")"
echo "${submit_response}"

job_id="$(echo "${submit_response}" | sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p')"
if [ -z "${job_id}" ]; then
  echo "[smoke] failed to parse job_id" >&2
  exit 1
fi

echo "[smoke] polling job_id=${job_id}"
for _ in $(seq 1 "${POLL_MAX}"); do
  status_response="$(curl -fsS "${BASE_URL}/api/review/jobs/${job_id}")"
  echo "${status_response}"
  ok_flag="$(echo "${status_response}" | sed -n 's/.*"ok":\([^,}]*\).*/\1/p' | tr -d ' ')"
  if [ "${ok_flag}" = "false" ]; then
    echo "[smoke] review failed" >&2
    exit 2
  fi
  job_status="$(echo "${status_response}" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  if [ "${job_status}" = "succeeded" ]; then
    echo "[smoke] review succeeded"
    exit 0
  fi
  if [ "${job_status}" = "failed" ]; then
    echo "[smoke] review failed" >&2
    exit 2
  fi
  sleep "${POLL_SECONDS}"
done

echo "[smoke] timeout waiting for job completion" >&2
exit 3
