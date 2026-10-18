-- migrate:up

-- Ranked full-text search plus typo-tolerant matching on titles and authors.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Weighted document: a hit in the title or author outranks a hit in genre,
-- which outranks a hit in the reviewer's name or the review body.
ALTER TABLE reviews ADD COLUMN search tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(author, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(genre, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(reviewer, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(review, '')), 'D')
    ) STORED;

CREATE INDEX reviews_search_idx ON reviews USING gin (search);
CREATE INDEX reviews_title_author_trgm_idx
    ON reviews USING gin ((title || ' ' || author) gin_trgm_ops);

-- One search used by both the web app and the agent. SECURITY INVOKER (the
-- default), so it runs with the caller's own grants: agent_ro can call it
-- and is still read-only.
--
-- q is free text in web-search syntax: words are ANDed, "quoted phrases"
-- match exactly, -word excludes, "or" between words. English stemming means
-- "politics" finds "political". Titles and authors also match on trigram
-- similarity, which catches typos ("piranisi", "le guinn").
--
-- The other arguments are filters, ANDed with each other and with q:
--   has_title, has_author, has_genre, has_reviewer   field contains the value,
--                                                    any case
--   not_title, not_author, not_genre, not_reviewer   field contains none of
--                                                    these values
--   rating_min, rating_max                           inclusive star range
-- The search box's "author:x rating:>=4" syntax is parsed into these by the
-- web app (web/src/lib/searchQuery.ts); nothing here parses q.
-- With no q, returns the newest reviews matching the filters.

CREATE FUNCTION search_reviews(
    q            text   DEFAULT NULL,
    has_title    text   DEFAULT NULL,
    has_author   text   DEFAULT NULL,
    has_genre    text   DEFAULT NULL,
    has_reviewer text   DEFAULT NULL,
    not_title    text[] DEFAULT NULL,
    not_author   text[] DEFAULT NULL,
    not_genre    text[] DEFAULT NULL,
    not_reviewer text[] DEFAULT NULL,
    rating_min   int    DEFAULT NULL,
    rating_max   int    DEFAULT NULL,
    max_results  int    DEFAULT 20
)
RETURNS TABLE (
    id          int,
    title       text,
    author      text,
    genre       text,
    rating      smallint,
    review      text,
    reviewer    text,
    created_at  timestamptz,
    updated_at  timestamptz,
    score       real
)
LANGUAGE sql
STABLE
SET pg_trgm.word_similarity_threshold = 0.45
-- Stop-word-only queries make Postgres emit a NOTICE per row; they're noise.
SET client_min_messages = warning
AS $$
    WITH input AS (
        SELECT nullif(trim(q), '') AS text,
               websearch_to_tsquery('english', coalesce(q, '')) AS tsq
    ),
    -- A query of only stop words ("the") has no lexemes; skip full-text then
    -- and rely on the fuzzy title/author match.
    input2 AS (
        SELECT text, tsq, numnode(tsq) > 0 AS has_terms FROM input
    ),
    scored AS (
        SELECT r.*,
               CASE WHEN i.text IS NULL THEN 0
                    -- 32: rank / (rank + 1), so full-text scores sit in 0..1
                    ELSE CASE WHEN i.has_terms
                              THEN ts_rank_cd('{0.1, 0.2, 0.4, 1.0}', r.search, i.tsq, 32)
                              ELSE 0 END
                         + word_similarity(i.text, r.title || ' ' || r.author)
               END::real AS score
        FROM reviews r, input2 i
        WHERE (i.text IS NULL
               OR (i.has_terms AND r.search @@ i.tsq)
               OR i.text <% (r.title || ' ' || r.author))
          -- strpos rather than ILIKE, so values need no escaping. A NULL
          -- genre or reviewer fails a has_ filter and passes a not_ filter.
          AND (has_title    IS NULL OR strpos(lower(r.title), lower(has_title)) > 0)
          AND (has_author   IS NULL OR strpos(lower(r.author), lower(has_author)) > 0)
          AND (has_genre    IS NULL OR strpos(lower(r.genre), lower(has_genre)) > 0)
          AND (has_reviewer IS NULL OR strpos(lower(r.reviewer), lower(has_reviewer)) > 0)
          AND NOT EXISTS (SELECT 1 FROM unnest(not_title) v    WHERE strpos(lower(r.title), lower(v)) > 0)
          AND NOT EXISTS (SELECT 1 FROM unnest(not_author) v   WHERE strpos(lower(r.author), lower(v)) > 0)
          AND NOT EXISTS (SELECT 1 FROM unnest(not_genre) v    WHERE strpos(lower(r.genre), lower(v)) > 0)
          AND NOT EXISTS (SELECT 1 FROM unnest(not_reviewer) v WHERE strpos(lower(r.reviewer), lower(v)) > 0)
          AND (rating_min IS NULL OR r.rating >= rating_min)
          AND (rating_max IS NULL OR r.rating <= rating_max)
    )
    SELECT id, title, author, genre, rating, review, reviewer, created_at, updated_at, score
    FROM scored
    ORDER BY score DESC, created_at DESC
    LIMIT least(greatest(max_results, 1), 100)
$$;

-- migrate:down

DROP FUNCTION search_reviews(text, text, text, text, text, text[], text[], text[], text[], int, int, int);
DROP INDEX reviews_title_author_trgm_idx;
DROP INDEX reviews_search_idx;
ALTER TABLE reviews DROP COLUMN search;
DROP EXTENSION pg_trgm;
