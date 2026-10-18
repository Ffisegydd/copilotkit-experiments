"""Read-only Postgres access for the agent.

`ReviewsDB` is created by the app (main.py) and handed to tools through the
graph's runtime context (see src/context.py); nothing here is a global.

The connection string must point at the `agent_ro` role, which has SELECT on
`reviews` and nothing else, with every session forced read-only. On top of
that, each query here runs inside an explicit READ ONLY transaction, so the
guarantee doesn't depend on the role being configured correctly.
"""

from decimal import Decimal
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

MAX_ROWS = 100


class ReviewsDB:
    def __init__(self, url: str, *, max_size: int = 4):
        self._pool = AsyncConnectionPool(
            url,
            min_size=1,
            max_size=max_size,
            kwargs={"row_factory": dict_row, "autocommit": True},
            open=False,
        )

    async def open(self) -> None:
        await self._pool.open()

    async def close(self) -> None:
        await self._pool.close()

    async def fetch(self, sql: str, params: dict[str, Any] | None = None) -> list[dict]:
        async with self._pool.connection() as conn:
            async with conn.transaction():
                await conn.execute("SET TRANSACTION READ ONLY")
                cur = await conn.execute(sql, params)
                rows = await cur.fetchmany(MAX_ROWS)
        return [_jsonable(r) for r in rows]


def _jsonable(row: dict) -> dict:
    return {k: _jsonable_value(v) for k, v in row.items()}


def _jsonable_value(v: Any) -> Any:
    """Make a column value JSON-native. LangChain JSON-encodes tool results,
    but falls back to Python's repr for the whole result if any value isn't
    serialisable (numeric -> Decimal('4.00')), which the chat UI can't parse."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, Decimal):
        return float(v)
    if hasattr(v, "isoformat"):  # date, time, datetime
        return v.isoformat()
    if isinstance(v, (list, tuple)):
        return [_jsonable_value(x) for x in v]
    if isinstance(v, dict):
        return {k: _jsonable_value(x) for k, x in v.items()}
    return str(v)  # interval, uuid, bytes, ...


class ReadWriteDB(ReviewsDB):
    """Read-write access for the api process (api.py), connected as `app_rw`.
    The agent process never builds one: it only has the `agent_ro` URL."""

    async def write(self, sql: str, params: dict[str, Any] | None = None) -> tuple[list[dict], int]:
        """Run one statement in its own transaction. Returns the rows it
        RETURNING-ed and how many rows it touched."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(sql, params)
            rows = await cur.fetchall() if cur.description else []
            return [_jsonable(r) for r in rows], cur.rowcount
