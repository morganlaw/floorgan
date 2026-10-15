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

// Snap an end point to 0, 45, or 90 degrees relative to start point if Shift is pressed
export function snapAngle(start: Point, current: Point): Point {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const angle = Math.atan2(dy, dx);
  const dist = Math.hypot(dx, dy);

  // Snap to nearest 45 degrees (PI / 4)
  const snapIncrement = Math.PI / 4;
  const snappedAngle = Math.round(angle / snapIncrement) * snapIncrement;

  return {
    x: Math.round(start.x + dist * Math.cos(snappedAngle)),
    y: Math.round(start.y + dist * Math.sin(snappedAngle)),
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
