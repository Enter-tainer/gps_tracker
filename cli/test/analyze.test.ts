import assert from "node:assert/strict";
import test from "node:test";

import { encodeGpsl0Points } from "../../frontend/src/services/gpsl0/index.ts";
import { wgs84ToGcj02 } from "../../frontend/src/utils/coordTransform.ts";
import {
  analyzeTrack,
  computeExactProximity,
  decodeTrackPoints,
  downsamplePoints,
  formatGeoJson,
  formatGpx,
  locateAtTimestamp,
  normalizeCoordInput
} from "../src/analyze.ts";

function buildSyntheticTrack() {
  const baseTs = 1_760_000_000; // 2025-10-09T...
  const pts: Array<{
    timestamp: number;
    latitude_scaled_1e7: number;
    longitude_scaled_1e7: number;
    altitude_m_scaled_1e1: number;
  }> = [];

  // Phase 1: Walking north from (39.8980, 116.4000) towards 39.9015 (~390m in 140s)
  for (let i = 0; i < 14; i++) {
    pts.push({
      timestamp: baseTs + i * 10,
      latitude_scaled_1e7: Math.round((39.8980 + i * 0.00025) * 1e7),
      longitude_scaled_1e7: Math.round(116.4000 * 1e7),
      altitude_m_scaled_1e1: Math.round((50 + i * 0.5) * 10)
    });
  }

  // Phase 2: Stop cluster around (39.9015, 116.4000) for 600s (10 min)
  const stopLat = 39.9015;
  const stopLon = 116.4000;
  for (let k = 0; k <= 20; k++) {
    pts.push({
      timestamp: baseTs + 150 + k * 30,
      latitude_scaled_1e7: Math.round((stopLat + (k % 2) * 0.00002) * 1e7),
      longitude_scaled_1e7: Math.round((stopLon - (k % 2) * 0.00002) * 1e7),
      altitude_m_scaled_1e1: 550
    });
  }

  // Phase 3: Cycling east for 15 steps (150s)
  for (let m = 1; m <= 15; m++) {
    pts.push({
      timestamp: baseTs + 750 + m * 10,
      latitude_scaled_1e7: Math.round(stopLat * 1e7),
      longitude_scaled_1e7: Math.round((stopLon + m * 0.0006) * 1e7),
      altitude_m_scaled_1e1: Math.round((55 + m * 1.0) * 10)
    });
  }

  return { baseTs, pts };
}

test("GPSL0 encode -> decode roundtrip & track analysis", () => {
  const { baseTs, pts } = buildSyntheticTrack();
  const encoded = encodeGpsl0Points(pts);
  const decoded = decodeTrackPoints(encoded);

  assert.equal(decoded.length, pts.length);
  assert.equal(decoded[0].ts, baseTs);
  assert.ok(Math.abs(decoded[0].lat - 39.898) < 1e-6);
  assert.ok(Math.abs(decoded[0].lon - 116.4) < 1e-6);

  const summary = analyzeTrack(decoded, {
    stopRadiusM: 100,
    stopMinDurationS: 300,
    maxWaypoints: 12
  });

  assert.equal(summary.point_count, pts.length);
  assert.equal(summary.stops.length, 1);
  assert.ok(summary.stops[0].duration_s >= 550);
  assert.ok(Math.abs(summary.stops[0].lat - 39.9015) < 0.0005);
  assert.equal(summary.segments.length, 2);
  assert.ok(summary.distance_m > 800);
  assert.ok(summary.elev_gain_m >= 10);
  assert.ok(summary.waypoints.length <= 12);
});

test("locateAtTimestamp interpolates accurately inside segment and reports nearest outside", () => {
  const { baseTs, pts } = buildSyntheticTrack();
  const decoded = decodeTrackPoints(encodeGpsl0Points(pts));

  // Midpoint between sample 0 (baseTs, 39.8980) and sample 1 (baseTs + 10, 39.89825)
  const mid = locateAtTimestamp(decoded, baseTs + 5);
  assert.equal(mid.mode, "interpolated");
  assert.equal(mid.delta_s, 0);
  assert.ok(mid.lat !== null && Math.abs(mid.lat - 39.898125) < 1e-4);
  assert.ok(mid.speed_kmh !== null && mid.speed_kmh > 1);

  // Outside range
  const before = locateAtTimestamp(decoded, baseTs - 120);
  assert.equal(before.mode, "nearest");
  assert.equal(before.delta_s, 120);
});

test("computeExactProximity + GCJ-02 -> WGS-84 coordinate normalization", () => {
  const { pts } = buildSyntheticTrack();
  const decoded = decodeTrackPoints(encodeGpsl0Points(pts));

  // Convert a point near the stop cluster to GCJ-02, then normalize back
  const [gLat, gLon] = wgs84ToGcj02(39.9015, 116.4000);
  const [wLat, wLon] = normalizeCoordInput(gLat, gLon, "gcj02");
  assert.ok(Math.abs(wLat - 39.9015) < 1e-4);
  assert.ok(Math.abs(wLon - 116.4000) < 1e-4);

  const prox = computeExactProximity(decoded, wLat, wLon, 50);
  assert.ok(prox !== null);
  assert.equal(prox.within_radius, true);
  assert.ok(prox.min_distance_m < 10);
  assert.ok(prox.visits.length >= 1);

  const far = computeExactProximity(decoded, 31.2304, 121.4737, 500);
  assert.ok(far !== null);
  assert.equal(far.within_radius, false);
});

test("downsampling and GPX / GeoJSON export formatting", () => {
  const { pts } = buildSyntheticTrack();
  const decoded = decodeTrackPoints(encodeGpsl0Points(pts));

  const sampled = downsamplePoints(decoded, 10);
  assert.equal(sampled.length, 10);
  assert.equal(sampled[0].ts, decoded[0].ts);
  assert.equal(sampled[sampled.length - 1].ts, decoded[decoded.length - 1].ts);

  const gpx = formatGpx({ id: "t-1", title: "Morning & Walk" }, sampled);
  assert.ok(gpx.includes("<name>Morning &amp; Walk</name>"));
  assert.ok(gpx.includes("<trkpt lat=\"39.8980000\""));

  const geojson = JSON.parse(
    formatGeoJson(
      {
        id: "t-1",
        date: "2025-10-09",
        title: "Morning Walk",
        source_file: "t1.gpz",
        point_count: decoded.length,
        distance_m: 1000,
        distance_km: 1,
        duration_s: 850,
        elev_gain_m: 15,
        min_ele: 50,
        max_ele: 70,
        start_time: decoded[0].ts,
        end_time: decoded[decoded.length - 1].ts,
        start_iso: null,
        end_iso: null,
        min_lat: 39.9,
        max_lat: 39.902,
        min_lon: 116.4,
        max_lon: 116.41,
        r2_key: "d1://track_blobs/t-1",
        created_at: decoded[0].ts
      },
      sampled
    )
  );
  assert.equal(geojson.type, "FeatureCollection");
  assert.equal(geojson.features[0].geometry.type, "LineString");
  assert.equal(geojson.features[0].geometry.coordinates.length, 10);
});
