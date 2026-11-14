-- D1 schema for personal GPS tracks and Zoom-15 spatial tile index

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  source_file TEXT NOT NULL,
  point_count INTEGER NOT NULL,
  distance_m REAL NOT NULL,
  duration_s INTEGER NOT NULL,
  elev_gain_m REAL NOT NULL,
  min_ele REAL NOT NULL,
  max_ele REAL NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  min_lat REAL NOT NULL,
  max_lat REAL NOT NULL,
  min_lon REAL NOT NULL,
  max_lon REAL NOT NULL,
  r2_key TEXT NOT NULL,
  overview_coords TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracks_date ON tracks(date DESC, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_bbox ON tracks(min_lat, max_lat, min_lon, max_lon);

CREATE TABLE IF NOT EXISTS track_tiles (
  tile_key INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  point_count INTEGER NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (tile_key, track_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_track_tiles_track_id ON track_tiles(track_id);

-- Separate rowid table so 10-22 KB GPSL0 BLOBs spill to SQLite overflow pages
-- without bloating the `tracks` metadata B-Tree scanned by /api/bootstrap.
CREATE TABLE IF NOT EXISTS track_blobs (
  track_id TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
