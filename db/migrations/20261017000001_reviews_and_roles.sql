-- migrate:up

CREATE TABLE reviews (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    author      TEXT NOT NULL,
    genre       TEXT,
    rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review      TEXT NOT NULL DEFAULT '',
    reviewer    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE TEMPORARY ON DATABASE books FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Role used by the web app for CRUD.
CREATE ROLE app_rw LOGIN PASSWORD 'app_rw_pw';
GRANT CONNECT ON DATABASE books TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON reviews TO app_rw;
GRANT USAGE, SELECT ON SEQUENCE reviews_id_seq TO app_rw;

-- Role used by the LangChain agent: SELECT on one table, every session forced
-- read-only, short statement timeout. No temp tables, and no server-side file
-- access (pg_read_file / COPY FROM need superuser or pg_read_server_files).
CREATE ROLE agent_ro LOGIN PASSWORD 'agent_ro_pw';
GRANT CONNECT ON DATABASE books TO agent_ro;
GRANT USAGE ON SCHEMA public TO agent_ro;
GRANT SELECT ON reviews TO agent_ro;
ALTER ROLE agent_ro SET default_transaction_read_only = on;
ALTER ROLE agent_ro SET statement_timeout = '5s';

-- migrate:down

-- DROP OWNED removes the roles' grants, which DROP ROLE would otherwise
-- refuse over. The REVOKEs from PUBLIC aren't undone: Postgres 15+ doesn't
-- grant CREATE on public by default anyway.
DROP TABLE reviews;
DROP OWNED BY app_rw, agent_ro;
DROP ROLE app_rw;
DROP ROLE agent_ro;
