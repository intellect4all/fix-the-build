-- Players, runs, and per-tier bug counts (so the score can be recomputed exactly).
-- Times are Unix milliseconds.
CREATE TABLE players (
  id              INTEGER PRIMARY KEY,
  device_token    TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  handle_type     TEXT NOT NULL CHECK (handle_type IN ('x','linkedin')),
  handle          TEXT NOT NULL,
  commit_message  TEXT NOT NULL,
  hidden          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (handle_type, handle)
);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  device_token  TEXT NOT NULL,
  player_id     INTEGER REFERENCES players(id) ON DELETE CASCADE,
  seed          INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  bugs          INTEGER,
  bugs_x1       INTEGER,
  bugs_x2       INTEGER,
  bugs_x3       INTEGER,
  golden        INTEGER,
  features_hit  INTEGER,
  max_combo     INTEGER,
  taps          INTEGER,
  score         INTEGER,
  flagged       INTEGER NOT NULL DEFAULT 0,
  flag_reason   TEXT
);
CREATE INDEX runs_device ON runs(device_token);
CREATE INDEX runs_player_score ON runs(player_id, score DESC);
