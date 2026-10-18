# Node builds the web app; the image that runs has only Python. Two processes:
#   - api (FastAPI): the built web app, reviews REST, MCP, and a proxy to the
#     agent, on :3000, published
#   - LangGraph agent (FastAPI + ag-ui-langgraph) on 127.0.0.1:8123, internal only

FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.5.8 /uv /usr/local/bin/uv

# Separate unprivileged users so the agent can't read the api process's
# environment (which holds the read-write DB credentials) and owns no files.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin api \
 && useradd --system --no-create-home --shell /usr/sbin/nologin agent

WORKDIR /app/agent
COPY agent/pyproject.toml agent/uv.lock ./
RUN UV_PYTHON_DOWNLOADS=never uv sync --frozen --no-install-project --no-dev
COPY agent/main.py agent/api.py ./
COPY agent/src ./src

COPY --from=web /web/dist /app/web/dist

WORKDIR /app
COPY entrypoint.sh ./
RUN chmod 755 entrypoint.sh

ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 3000
CMD ["/app/entrypoint.sh"]
