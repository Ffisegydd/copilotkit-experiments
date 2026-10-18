# One image, three processes:
#   - Next.js (UI, CopilotKit runtime, proxy to the api) on :3000, published
#   - api (FastAPI: reviews REST + MCP server) on 127.0.0.1:8124, internal only
#   - LangGraph agent (FastAPI + ag-ui-langgraph) on 127.0.0.1:8123, internal only

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npx next build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.5.8 /uv /usr/local/bin/uv
COPY --from=web /usr/local/bin/node /usr/local/bin/node

# Separate unprivileged users so the agent can't read the api process's
# environment (which holds the read-write DB credentials) and owns no files.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin web \
 && useradd --system --no-create-home --shell /usr/sbin/nologin api \
 && useradd --system --no-create-home --shell /usr/sbin/nologin agent

WORKDIR /app/agent
COPY agent/pyproject.toml agent/uv.lock ./
RUN UV_PYTHON_DOWNLOADS=never uv sync --frozen --no-install-project --no-dev
COPY agent/main.py agent/api.py ./
COPY agent/src ./src

WORKDIR /app/web
COPY --from=web /web/.next/standalone ./
COPY --from=web /web/.next/static ./.next/static

WORKDIR /app
COPY entrypoint.sh ./
RUN chmod 755 entrypoint.sh

ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1
EXPOSE 3000
CMD ["/app/entrypoint.sh"]
