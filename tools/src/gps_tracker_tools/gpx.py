"""GPX export utilities shared across Apple Find My and Google FMDN modules."""

import datetime
import math
import sys


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance between two points in meters."""
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def dedupe_reports(
    reports: list[dict], radius_m: float = 50.0
) -> list[dict]:
    """Dedupe reports: within each counter, merge points closer than `radius_m`.

    For each cluster of nearby points, keep the one with the highest confidence.
    Different locations within the same counter are preserved.

    Reports without a 'counter' field are grouped by timestamp bucket (15 min).
    """
    by_counter: dict[int, list[dict]] = {}
    for r in reports:
        key = r.get("counter", r["timestamp"] // 900)
        by_counter.setdefault(key, []).append(r)

    result = []
    for _counter, group in sorted(by_counter.items()):
        clusters: list[list[dict]] = []
        for r in sorted(group, key=lambda x: -x.get("confidence", 0)):
            merged = False
            for cluster in clusters:
                ref = cluster[0]
                if (
                    haversine_m(ref["lat"], ref["lon"], r["lat"], r["lon"])
                    < radius_m
                ):
                    cluster.append(r)
                    merged = True
                    break
            if not merged:
                clusters.append([r])
        for cluster in clusters:
            result.append(
                max(cluster, key=lambda r: r.get("confidence", 0))
            )

    return sorted(result, key=lambda r: r["timestamp"])


def reports_to_gpx(
    reports: list[dict], name: str = "GPS Tracker"
) -> str:
    """Convert location reports to GPX XML string."""
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="gps-tracker-tools"',
        '     xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <metadata><name>{name}</name></metadata>",
        "  <trk>",
        f"    <name>{name}</name>",
        "    <trkseg>",
    ]
    for r in reports:
        ts = datetime.datetime.fromtimestamp(
            r["timestamp"], tz=datetime.timezone.utc
        )
        lines.append(
            f'      <trkpt lat="{r["lat"]:.7f}" lon="{r["lon"]:.7f}">'
        )
        lines.append(f"        <time>{ts.isoformat()}</time>")
        if "confidence" in r:
            lines.append(f"        <hdop>{r['confidence']}</hdop>")
        if "accuracy" in r:
            lines.append(f"        <hdop>{r['accuracy']}</hdop>")
        lines.append("      </trkpt>")
    lines += ["    </trkseg>", "  </trk>", "</gpx>", ""]
    return "\n".join(lines)


def write_gpx(
    reports: list[dict], gpx_path: str, dedupe: bool = True
) -> None:
    """Dedupe reports and write GPX file."""
    if dedupe:
        original = len(reports)
        reports = dedupe_reports(reports)
        if original != len(reports):
            print(
                f"Deduped {original} reports -> {len(reports)} points",
                file=sys.stderr,
            )
    gpx = reports_to_gpx(reports)
    with open(gpx_path, "w") as f:
        f.write(gpx)
    print(f"GPX written to {gpx_path}", file=sys.stderr)
