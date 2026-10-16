import { Point, Unit } from '../types';

export function snapToGrid(value: number, gridSize: number, enabled: boolean): number {
  if (!enabled || gridSize <= 0) return Math.round(value);
  return Math.round(value / gridSize) * gridSize;
}

export function snapPointToGrid(p: Point, gridSize: number, enabled: boolean): Point {
  return {
    x: snapToGrid(p.x, gridSize, enabled),
    y: snapToGrid(p.y, gridSize, enabled),
  };
}

export function distance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Snap an end point to 0, 45, or 90 degrees relative to start point with grid length alignment
export function snapAngle(start: Point, current: Point, gridSize?: number, gridSnap?: boolean): Point {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return start;

  const angle = Math.atan2(dy, dx);
  const snapIncrement = Math.PI / 4; // 45 deg
  const snappedAngle = Math.round(angle / snapIncrement) * snapIncrement;

  let finalDist = dist;
  if (gridSnap && gridSize && gridSize > 0) {
    finalDist = Math.max(gridSize, Math.round(dist / gridSize) * gridSize);
  }

  // If strictly horizontal (0 or 180 deg)
  if (Math.abs(Math.sin(snappedAngle)) < 1e-4) {
    const sign = Math.cos(snappedAngle) >= 0 ? 1 : -1;
    return {
      x: start.x + sign * finalDist,
      y: start.y,
    };
  }

  // If strictly vertical (90 or 270 deg)
  if (Math.abs(Math.cos(snappedAngle)) < 1e-4) {
    const sign = Math.sin(snappedAngle) >= 0 ? 1 : -1;
    return {
      x: start.x,
      y: start.y + sign * finalDist,
    };
  }

  return {
    x: Math.round(start.x + finalDist * Math.cos(snappedAngle)),
    y: Math.round(start.y + finalDist * Math.sin(snappedAngle)),
  };
}

export function formatDimension(cm: number, unit: Unit): string {
  if (unit === 'm') {
    const meters = cm / 100;
    return `${meters.toFixed(2)} m`;
  } else {
    const totalInches = cm / 2.54;
    const feet = Math.floor(totalInches / 12);
    const inches = Math.round(totalInches % 12);
    return `${feet}' ${inches}"`;
  }
}
