#!/usr/bin/env bash
# run.sh — canonical rebuild + redeploy for llm-dash.
# Run this ON the worker node, from the repo directory:
#   DEPLOY_BIND_IP=<worker-lan-ip> SSH_KEY_PATH=<path-to-dashboard-key> SSH_USER=<remote-user> ./deploy/run.sh
set -euo pipefail

: "${DEPLOY_BIND_IP:?Set DEPLOY_BIND_IP to the LAN IP this container should listen on}"
: "${SSH_KEY_PATH:?Set SSH_KEY_PATH to the host path of the dedicated dashboard SSH private key}"
: "${SSH_USER:?Set SSH_USER to the remote user the forced-command key authenticates as}"

cd "$(dirname "$0")/.."

docker build -t llm-dash .

docker rm -f llm-dash 2>/dev/null || true

docker run -d \
  --name llm-dash \
  --restart unless-stopped \
  --init \
  --user 1000:1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --memory 256m \
  --memory-swap 256m \
  --pids-limit 128 \
  -p "${DEPLOY_BIND_IP}:9090:9090" \
  -v "${SSH_KEY_PATH}:/home/node/.ssh/id_ed25519_llmdash:ro" \
  -e SSH_KEY=/home/node/.ssh/id_ed25519_llmdash \
  -e SSH_USER="${SSH_USER}" \
  -e NODE_OPTIONS=--max-old-space-size=128 \
  llm-dash
