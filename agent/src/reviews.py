"""Reviews service: every query the app runs against the `reviews` table.

The REST API and the MCP server (api.py) and the chat agent's tools
(src/agent.py) are all thin wrappers over these functions. Reads take any
ReviewsDB; writes need a ReadWriteDB, which only the api process has.
"""

from typing import Optional

from pydantic import BaseModel, Field, field_validator

from src.db import MAX_ROWS, ReadWriteDB, ReviewsDB

COLUMNS = "id, title, author, genre, rating, review, reviewer, created_at, updated_at"

# Shared by the agent's and the MCP server's search tool, which take the same
# arguments as search() below.
SEARCH_DESCRIPTION = """Search saved book reviews, best matches first (each row has a `score`).

`query` is free text matched against title, author, genre, reviewer name
and review body, e.g. "Piranesi Susanna Clarke" or "cosy mystery". Words
are stemmed ("politics" finds "political") and all must match. Web-search
syntax works: "exact phrase", -excluded, word or word. Misspelt titles and
authors still match ("piranisi", "le guinn"). Field filters like
author:x are NOT parsed here; use the arguments below.

`title`, `author`, `genre`, `reviewer`: the field contains this, any case
(genre="fiction" matches every genre containing "fiction").
`exclude_*`: drop rows whose field contains any of these.
`min_rating`/`max_rating`: inclusive, 1-5.
All filters are ANDed with each other and with `query`. Leave everything
empty to list the newest reviews."""


class ReviewInput(BaseModel):
    """A review as the user saves it. Extra keys (the form sends its `id`)
    are ignored."""

    title: str
    author: str
    genre: Optional[str] = None
    rating: int = Field(ge=1, le=5)
    review: str = ""
    reviewer: Optional[str] = None

    @field_validator("title", "author")
    @classmethod
    def required(cls, v: str, info) -> str:
        v = v.strip()
        if not v:
            raise ValueError(f"{info.field_name.capitalize()} is required")
        return v

    @field_validator("genre", "reviewer")
    @classmethod
    def blank_is_none(cls, v: Optional[str]) -> Optional[str]:
        return (v or "").strip() or None


async def search(
    db: ReviewsDB,
    query: Optional[str] = None,
    title: Optional[str] = None,
    author: Optional[str] = None,
    genre: Optional[str] = None,
    reviewer: Optional[str] = None,
    exclude_titles: Optional[list[str]] = None,
    exclude_authors: Optional[list[str]] = None,
    exclude_genres: Optional[list[str]] = None,
    exclude_reviewers: Optional[list[str]] = None,
    min_rating: Optional[int] = None,
    max_rating: Optional[int] = None,
    limit: int = 20,
) -> list[dict]:
    """Ranked full-text + fuzzy search (search_reviews in
    db/migrations/*_search.sql). See SEARCH_DESCRIPTION."""
    rows = await db.fetch(
        """SELECT * FROM search_reviews(
               q => %(q)s,
               has_title => %(title)s, has_author => %(author)s,
               has_genre => %(genre)s, has_reviewer => %(reviewer)s,
               not_title => %(not_title)s, not_author => %(not_author)s,
               not_genre => %(not_genre)s, not_reviewer => %(not_reviewer)s,
               rating_min => %(min_rating)s, rating_max => %(max_rating)s,
               max_results => %(limit)s)""",
        {
            "q": query,
            "title": title,
            "author": author,
            "genre": genre,
            "reviewer": reviewer,
            "not_title": exclude_titles,
            "not_author": exclude_authors,
            "not_genre": exclude_genres,
            "not_reviewer": exclude_reviewers,
            "min_rating": min_rating,
            "max_rating": max_rating,
            "limit": min(limit, MAX_ROWS),
        },
    )
    return [{**r, "score": round(r["score"], 3)} for r in rows]


async def no_genre_match(db: ReviewsDB, genre: str) -> str:
    """What a search tool says when a genre filter matched nothing, so the
    model can retry with a genre that exists."""
    rows = await db.fetch("SELECT DISTINCT genre FROM reviews WHERE genre IS NOT NULL ORDER BY 1")
    return f"No matches with genre={genre!r}. Genres are: " + ", ".join(r["genre"] for r in rows)


async def get(db: ReviewsDB, id: int) -> dict | None:
    rows = await db.fetch(f"SELECT {COLUMNS} FROM reviews WHERE id = %(id)s", {"id": id})
    return rows[0] if rows else None


async def create(db: ReadWriteDB, r: ReviewInput) -> dict:
    rows, _ = await db.write(
        f"""INSERT INTO reviews (title, author, genre, rating, review, reviewer)
            VALUES (%(title)s, %(author)s, %(genre)s, %(rating)s, %(review)s, %(reviewer)s)
            RETURNING {COLUMNS}""",
        r.model_dump(),
    )
    return rows[0]


async def update(db: ReadWriteDB, id: int, r: ReviewInput) -> dict | None:
    rows, _ = await db.write(
        f"""UPDATE reviews
            SET title = %(title)s, author = %(author)s, genre = %(genre)s, rating = %(rating)s,
                review = %(review)s, reviewer = %(reviewer)s, updated_at = now()
            WHERE id = %(id)s RETURNING {COLUMNS}""",
        {**r.model_dump(), "id": id},
    )
    return rows[0] if rows else None


async def delete(db: ReadWriteDB, id: int) -> bool:
    _, count = await db.write("DELETE FROM reviews WHERE id = %(id)s", {"id": id})
    return count > 0
