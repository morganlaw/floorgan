import { FloorplanState } from '../types';
import { adoptLegacyUnderlay, getInlineFallback } from './underlayStore.ts';

const STORAGE_KEY = 'floorgan_floorplan_v1';
const LEGACY_STORAGE_KEY = 'mapgan_floorplan_v1';

/** Reads the saved plan. Pure apart from registering a legacy embedded image for display. */
export function loadSavedFloorplan(): FloorplanState | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (!parsed || !Array.isArray(parsed.walls)) return null;

    let background = parsed.background ?? null;
    // Plans saved before images moved to IndexedDB embed the image as a data URL.
    if (background && !background.imageId && typeof background.dataUrl === 'string') {
      const { dataUrl, ...rest } = background;
      background = { ...rest, imageId: adoptLegacyUnderlay(dataUrl) };
    }

    return {
      ...parsed,
      measurements: parsed.measurements || [],
      background,
    };
  } catch (e) {
    console.warn('Could not load saved floorplan from localStorage', e);
    return null;
  }
}

function serialize(state: FloorplanState): string {
  const bg = state.background;
  if (bg?.imageId) {
    // Not yet confirmed in IndexedDB: keep embedding it so it can't be lost.
    const inline = getInlineFallback(bg.imageId);
    if (inline) {
      return JSON.stringify({ ...state, background: { ...bg, imageId: undefined, dataUrl: inline } });
    }
  }
  return JSON.stringify(state);
}

export function saveFloorplan(state: FloorplanState): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(state));
  } catch {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, background: null }));
      console.warn('Floorplan saved without background image (storage quota exceeded)');
    } catch (innerErr) {
      console.warn('Could not save floorplan to localStorage', innerErr);
    }
  }
}
