import type { StyleSpecification } from "maplibre-gl";
import {
  composeAtlasStyle,
  dropBaseRelief,
  type DemSourceLike,
  type StyleLike
} from "@atlas-realm/map";

export const DEFAULT_ATLAS_ORM_ORIGIN =
  (import.meta.env?.VITE_ATLAS_ORM_ORIGIN as string | undefined) ||
  "https://map.mgt.moe";

const OPENFREEMAP_LIBERTY_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export type LoadMapStyleOptions = {
  showRailway?: boolean;
  showTerrain?: boolean;
  ormOrigin?: string;
  demSource?: DemSourceLike;
};

let cachedBaseStyle: StyleSpecification | null = null;

function buildMinimalVectorFallbackStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      openmaptiles: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet"
      }
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#0b1324"
        }
      },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: {
          "fill-color": "#172a45"
        }
      },
      {
        id: "boundary-country",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        paint: {
          "line-color": "#475569",
          "line-width": 1
        }
      },
      {
        id: "transportation-major",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["in", "class", "motorway", "trunk", "primary", "secondary"],
        paint: {
          "line-color": "#334155",
          "line-width": 1.2
        }
      }
    ]
  };
}

export async function loadMapStyle(
  options: LoadMapStyleOptions = {}
): Promise<StyleSpecification> {
  const showRailway = Boolean(options.showRailway);
  const showTerrain = Boolean(options.showTerrain && options.demSource);
  const ormOrigin = options.ormOrigin ?? DEFAULT_ATLAS_ORM_ORIGIN;

  let baseStyle: StyleSpecification;
  if (cachedBaseStyle) {
    baseStyle = cachedBaseStyle;
  } else {
    try {
      const resp = await fetch(OPENFREEMAP_LIBERTY_STYLE_URL);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const rawStyle = (await resp.json()) as StyleSpecification;
      const processed = dropBaseRelief(
        rawStyle as unknown as StyleLike
      ) as unknown as StyleSpecification;
      cachedBaseStyle = processed;
      baseStyle = processed;
    } catch (err) {
      console.warn(
        `Failed to fetch OpenFreeMap style ${OPENFREEMAP_LIBERTY_STYLE_URL}, using minimal vector fallback:`,
        err
      );
      baseStyle = buildMinimalVectorFallbackStyle();
    }
  }

  if (!showRailway && !showTerrain) {
    return baseStyle;
  }

  try {
    return (await composeAtlasStyle(baseStyle as unknown as StyleLike, {
      dropRelief: false,
      orm: showRailway ? { ormOrigin, withBaseMapVisibility: false } : false,
      terrain:
        showTerrain && options.demSource
          ? { demSource: options.demSource }
          : false
    })) as unknown as StyleSpecification;
  } catch (err) {
    console.warn("Failed to compose Atlas Realm overlay, using base style:", err);
    if (showTerrain && options.demSource) {
      return (await composeAtlasStyle(baseStyle as unknown as StyleLike, {
        dropRelief: false,
        orm: false,
        terrain: { demSource: options.demSource }
      })) as unknown as StyleSpecification;
    }
    return baseStyle;
  }
}
