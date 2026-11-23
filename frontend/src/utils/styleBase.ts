import type { StyleSpecification } from "maplibre-gl";
import {
  composeAtlasStyle,
  type DemSourceLike,
  type StyleLike
} from "@atlas-realm/map";
import type { BaseMapId } from "../types/track.ts";

export const DEFAULT_ATLAS_ORM_ORIGIN =
  (import.meta.env?.VITE_ATLAS_ORM_ORIGIN as string | undefined) ||
  "https://map.mgt.moe";

export type LoadMapStyleOptions = {
  showRailway?: boolean;
  showTerrain?: boolean;
  ormOrigin?: string;
  demSource?: DemSourceLike;
};

type BaseStyleLayer = Record<string, unknown> & {
  id?: string;
  type?: string;
  source?: unknown;
  paint?: Record<string, unknown>;
};

type BaseStyle = Record<string, unknown> & {
  layers?: BaseStyleLayer[];
  sources?: Record<string, unknown>;
};

/**
 * The OpenFreeMap base style ships a pre-rendered Natural Earth shaded relief
 * raster (`ne2_shaded`, ~12 MB across the world at low zoom). Dropping it
 * follows enter-tainer/atlas-realm's optimization so the basemap renders 100%
 * crisp WebGL Vector Tiles with fast startup.
 */
export const BASE_RELIEF_SOURCE = "ne2_shaded";

export function dropBaseRelief<T extends BaseStyle>(style: T): T {
  const layers = style.layers ?? [];
  const keptLayers = layers.filter(
    (layer) => layer.source !== BASE_RELIEF_SOURCE
  );
  if (keptLayers.length === layers.length) return style;

  const sources = { ...(style.sources ?? {}) };
  if (!keptLayers.some((layer) => layer.source === BASE_RELIEF_SOURCE)) {
    delete sources[BASE_RELIEF_SOURCE];
  }
  return { ...style, layers: keptLayers, sources };
}

/**
 * OpenFreeMap's stock dark style uses very low contrast (#0c0c0c land,
 * #181818 roads), which merges visually into dark Fog of War overlays.
 * Boost vector paint contrast so landmasses, borders, roads, and labels stay crisp.
 */
export function enhanceDarkVectorStyle<T extends BaseStyle>(style: T): T {
  const layers = (style.layers ?? []).map((layer) => {
    const id = layer.id ?? "";
    const paint = layer.paint ? { ...layer.paint } : {};

    if (id === "background" && layer.type === "background") {
      paint["background-color"] = "#0b1324";
    } else if (id === "water" && layer.type === "fill") {
      paint["fill-color"] = "#172a45";
    } else if (id === "waterway" && layer.type === "line") {
      paint["line-color"] = "#1e3a5f";
    } else if (id.startsWith("boundary_")) {
      paint["line-color"] = "#475569";
    } else if (
      id === "highway_motorway_inner" ||
      id === "highway_motorway_subtle"
    ) {
      paint["line-color"] = "#38bdf8";
      paint["line-opacity"] = 0.72;
    } else if (
      id === "highway_major_inner" ||
      id === "highway_major_subtle" ||
      id === "highway_minor" ||
      id === "highway_path"
    ) {
      paint["line-color"] = "#334155";
      paint["line-opacity"] = 0.85;
    } else if (id === "highway_major_casing" || id === "highway_motorway_casing") {
      paint["line-color"] = "#1e293b";
    } else if (id === "building" && layer.type === "fill") {
      paint["fill-color"] = "#162033";
      paint["fill-outline-color"] = "#26354d";
    } else if (
      (id.startsWith("place_") || id === "water_name" || id.startsWith("highway_name_")) &&
      layer.type === "symbol"
    ) {
      paint["text-color"] = "#94a3b8";
      paint["text-halo-color"] = "rgba(11, 19, 36, 0.92)";
      paint["text-halo-width"] = 1.4;
    } else {
      return layer;
    }

    return { ...layer, paint };
  });

  return { ...style, layers };
}

export type BaseMapOption = {
  id: BaseMapId;
  label: string;
  description: string;
  isGcj02Default: boolean;
  isDark: boolean;
  styleUrl?: string;
  rasterTiles?: string[];
  attribution?: string;
};

export const BASE_MAP_OPTIONS: BaseMapOption[] = [
  {
    id: "openfreemap-liberty",
    label: "OpenFreeMap Liberty (Vector)",
    description: "Vector full street/terrain map (WGS-84, OpenFreeMap)",
    isGcj02Default: false,
    isDark: false,
    styleUrl: "https://tiles.openfreemap.org/styles/liberty"
  },
  {
    id: "openfreemap-bright",
    label: "OpenFreeMap Bright (Vector)",
    description: "Vector high-contrast daytime style (WGS-84, OpenFreeMap)",
    isGcj02Default: false,
    isDark: false,
    styleUrl: "https://tiles.openfreemap.org/styles/bright"
  },
  {
    id: "openfreemap-positron",
    label: "OpenFreeMap Positron (Vector)",
    description: "Vector minimalist light style (WGS-84, OpenFreeMap)",
    isGcj02Default: false,
    isDark: false,
    styleUrl: "https://tiles.openfreemap.org/styles/positron"
  },
  {
    id: "openfreemap-fiord",
    label: "OpenFreeMap Fiord (Vector)",
    description: "Vector deep navy style (WGS-84, OpenFreeMap)",
    isGcj02Default: false,
    isDark: true,
    styleUrl: "https://tiles.openfreemap.org/styles/fiord"
  },
  {
    id: "openfreemap-dark",
    label: "OpenFreeMap Dark (Vector)",
    description: "Vector dark style with enhanced contrast (WGS-84)",
    isGcj02Default: false,
    isDark: true,
    styleUrl: "https://tiles.openfreemap.org/styles/dark"
  },
  {
    id: "amap-standard",
    label: "高德标准 (GCJ-02)",
    description: "AMap detailed China street map (auto-enables GCJ-02 shift)",
    isGcj02Default: true,
    isDark: false,
    rasterTiles: [
      "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=2&style=7&x={x}&y={y}&z={z}",
      "https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=2&style=7&x={x}&y={y}&z={z}",
      "https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=2&style=7&x={x}&y={y}&z={z}",
      "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=2&style=7&x={x}&y={y}&z={z}"
    ],
    attribution: "&copy; AutoNavi"
  }
];

const styleCache = new Map<string, StyleSpecification>();

function buildRasterStyle(option: BaseMapOption): StyleSpecification {
  return {
    version: 8,
    sources: {
      "raster-base": {
        type: "raster",
        tiles: option.rasterTiles ?? [],
        tileSize: 256,
        attribution: option.attribution ?? ""
      }
    },
    layers: [
      {
        id: "raster-base-layer",
        type: "raster",
        source: "raster-base"
      }
    ]
  };
}

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
  baseMapId: BaseMapId,
  options: LoadMapStyleOptions = {}
): Promise<StyleSpecification> {
  const option =
    BASE_MAP_OPTIONS.find((item) => item.id === baseMapId) ?? BASE_MAP_OPTIONS[0];

  const allowAtlasOverlay = !option.isGcj02Default;
  const showRailway = Boolean(options.showRailway && allowAtlasOverlay);
  const showTerrain = Boolean(
    options.showTerrain && allowAtlasOverlay && options.demSource
  );
  const ormOrigin = options.ormOrigin ?? DEFAULT_ATLAS_ORM_ORIGIN;

  let baseStyle: StyleSpecification;
  if (option.rasterTiles) {
    baseStyle = buildRasterStyle(option);
  } else {
    const cachedBase = styleCache.get(option.id);
    if (cachedBase) {
      baseStyle = cachedBase;
    } else if (!option.styleUrl) {
      baseStyle = buildMinimalVectorFallbackStyle();
    } else {
      try {
        const resp = await fetch(option.styleUrl);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const rawStyle = (await resp.json()) as StyleSpecification;
        let processed = dropBaseRelief(rawStyle);
        if (option.id === "openfreemap-dark") {
          processed = enhanceDarkVectorStyle(processed);
        }
        styleCache.set(option.id, processed);
        baseStyle = processed;
      } catch (err) {
        console.warn(
          `Failed to fetch OpenFreeMap style ${option.styleUrl}, using minimal vector fallback:`,
          err
        );
        baseStyle = buildMinimalVectorFallbackStyle();
      }
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
          ? { demSource: options.demSource, darkTheme: option.isDark }
          : false
    })) as unknown as StyleSpecification;
  } catch (err) {
    console.warn("Failed to compose Atlas Realm overlay, using base style:", err);
    if (showTerrain && options.demSource) {
      return (await composeAtlasStyle(baseStyle as unknown as StyleLike, {
        dropRelief: false,
        orm: false,
        terrain: { demSource: options.demSource, darkTheme: option.isDark }
      })) as unknown as StyleSpecification;
    }
    return baseStyle;
  }
}
