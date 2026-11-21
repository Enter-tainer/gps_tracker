-- D1 schema for global hierarchical administrative regions (visited summary + track mapping)

CREATE TABLE IF NOT EXISTS visited_regions (
  region_id INTEGER PRIMARY KEY,
  level INTEGER NOT NULL,
  parent_id INTEGER,
  country TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  direct_child_count INTEGER NOT NULL,
  leaf_child_count INTEGER NOT NULL,
  lit_direct_children INTEGER NOT NULL,
  lit_leaf_children INTEGER NOT NULL,
  area_km2 REAL NOT NULL,
  explored_cells INTEGER NOT NULL,
  explored_area_km2 REAL NOT NULL,
  visit_days INTEGER NOT NULL,
  track_count INTEGER NOT NULL,
  heat REAL NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  bbox_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visited_regions_level ON visited_regions(level, heat DESC);

CREATE TABLE IF NOT EXISTS track_regions (
  region_id INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  cell_count INTEGER NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (region_id, track_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_track_regions_track_id ON track_regions(track_id);
