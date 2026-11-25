import type { Phase } from '@towercab/shared';

/** One colour per flight phase. The same values are in styles.css as `--phase-*`. */
export const PHASE_COLORS: Record<Phase, string> = {
  parked: '#8b9bb0',
  taxiing: '#fbbf24',
  takeoff_roll: '#fb923c',
  departing: '#4ade80',
  arriving: '#60a5fa',
  landing_roll: '#c084fc',
  pattern: '#2dd4bf',
  transit: '#e6edf3',
  vehicle: '#b8a98a',
};

/** The dark schematic palette: works at night, keeps aircraft and labels the brightest things on screen. */
export const SCHEMATIC = {
  ground: '#0b0f14',
  aerodrome: '#0f151c',
  apron: '#1a232e',
  taxiway: '#27333f',
  taxiwayLine: '#b8962e',
  runway: '#3a4653',
  runwayLine: '#e6edf3',
  holdLine: '#f59e0b',
  building: '#243140',
  buildingEdge: '#35475c',
  terminal: '#2c3d52',
  hangar: '#28364a',
  tower: '#3fd0ff',
  label: '#9fb0c3',
  sky: '#070a0e',
} as const;

export const UI = {
  accent: '#3fd0ff',
  text: '#e6edf3',
  muted: '#8b9bb0',
  panel: 'rgba(11, 15, 20, 0.82)',
  panelLine: 'rgba(63, 208, 255, 0.35)',
} as const;
