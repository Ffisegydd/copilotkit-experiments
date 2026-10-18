#!/bin/bash
# Starts both processes, each as its own user with only the env it needs.
# If either exits, the container exits.
set -euo pipefail

[ -n "${OPENAI_API_KEY:-}" ] || { echo "[entrypoint] OPENAI_API_KEY is not set; set it in .env." >&2; exit 1; }
[ -n "${MCP_TOKEN:-}" ] || echo "[entrypoint] MCP_TOKEN is not set; the MCP server at /mcp is off."

cd /app/agent
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  OPENAI_MODEL="${OPENAI_MODEL:-}" \
  AGENT_DATABASE_URL="$AGENT_DATABASE_URL" \
  setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs \
  /app/agent/.venv/bin/python main.py &
AGENT_PID=$!

env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent \
  API_HOST=0.0.0.0 API_PORT=3000 \
  WEB_DIST=/app/web/dist \
  AGENT_URL=http://127.0.0.1:8123 \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  OPENAI_MODEL="${OPENAI_MODEL:-}" \
  APP_DATABASE_URL="$APP_DATABASE_URL" \
  AGENT_DATABASE_URL="$AGENT_DATABASE_URL" \
  MCP_TOKEN="${MCP_TOKEN:-}" \
  setpriv --reuid=api --regid=api --clear-groups --no-new-privs \
  /app/agent/.venv/bin/python api.py &
API_PID=$!

trap 'kill $AGENT_PID $API_PID 2>/dev/null' TERM INT
wait -n $AGENT_PID $API_PID
