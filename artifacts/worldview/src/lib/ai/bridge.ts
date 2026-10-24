import type maplibregl from "maplibre-gl";
import type { Ship } from "../../components/ShipsLayer";
import type { SatPosition } from "../../components/SatelliteLayer";
import type { CableRoute, DataCenter, Dam, InfraLayerId, InfraSelection, LandingPoint } from "../infrastructure";
import type { CctvCamera } from "../cctv";
import type { Launch } from "../launches";
import type { Airport } from "../airports";
import type { EntityRef } from "../tracked-entity";
import type { FlirPalette, VisionMode } from "../vision-modes";
import type { CoverageMode } from "../viewshed";

export interface AircraftLite {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  gs?: number;
  track?: number;
  squawk?: string;
  t?: string;
  desc?: string;
  r?: string;
}

export type PanelId = "aviation" | "maritime" | "airport" | "traffic" | "infrastructure" | "space" | "cctv" | "playback";

/** Everything the AI copilot can see and do. Rebuilt by WorldviewMap on every render (read through a ref). */
export interface WorldBridge {
  map: maplibregl.Map | null;
  state: {
    viewMode: "2d" | "3d";
    visionMode: VisionMode;
    flirPalette: FlirPalette;
    aircraftMode: "civil" | "military";
    areaMode: "global" | "local";
    panels: Record<PanelId, boolean>;
    satIntelOn: boolean;
    focus: EntityRef | null;
    tracking: EntityRef | null;
    aircraft: AircraftLite[];
    ships: Ship[];
    sats: SatPosition[];
    infra: { datacenters: DataCenter[]; dams: Dam[]; landings: LandingPoint[]; cables: CableRoute[] };
    cctv: CctvCamera[];
    launches: { upcoming: Launch[]; previous: Launch[] } | null;
    airportView: Airport | null;
    infraSiteOpen: boolean;
    launchReplayOpen: boolean;
    cctvCoverage: CoverageMode;
  };
  actions: {
    setViewMode(m: "2d" | "3d"): void;
    setVisionMode(m: VisionMode): void;
    setFlirPalette(p: FlirPalette): void;
    setAircraftMode(m: "civil" | "military"): void;
    setAreaMode(m: "global" | "local"): void;
    setPanel(id: PanelId, open: boolean): void;
    setSatIntel(on: boolean): void;
    setInfraLayer(id: InfraLayerId, on: boolean): void;
    setCctvCoverage(mode: CoverageMode): void;
    selectEntity(ref: EntityRef): void;
    trackEntity(ref: EntityRef): void;
    clearTracking(): void;
    enterAirport(a: Airport): void;
    exitAirport(): void;
    enterInfraSite(sel: InfraSelection): void;
    exitInfraSite(): void;
    playLaunch(l: Launch, list: Launch[]): void;
    exitLaunchReplay(): void;
    selectCctv(cam: CctvCamera): void;
  };
}

export type BridgeRef = { current: WorldBridge | null };
