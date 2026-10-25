import { Point, Unit } from '../types';

export function snapToGrid(value: number, gridSize: number, enabled: boolean): number {
  if (!enabled || gridSize <= 0) return Math.round(value);
  return Math.round(value / gridSize) * gridSize;
}

export function snapPointToGrid(point: Point, gridSize: number, enabled: boolean): Point {
  return {
    x: snapToGrid(point.x, gridSize, enabled),
    y: snapToGrid(point.y, gridSize, enabled),
  };
}

export function distance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.hypot(dx, dy);
}

export function snapAngle(start: Point, current: Point, gridSize?: number, gridSnap?: boolean): Point {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return start;

  const angle = Math.atan2(dy, dx);
  const snapIncrement = Math.PI / 4;
  const snappedAngle = Math.round(angle / snapIncrement) * snapIncrement;

  let finalDist = dist;
  if (gridSnap && gridSize && gridSize > 0) {
    finalDist = Math.max(gridSize, Math.round(dist / gridSize) * gridSize);
  }

  const isHorizontal = Math.abs(Math.sin(snappedAngle)) < 1e-4;
  if (isHorizontal) {
    const sign = Math.cos(snappedAngle) >= 0 ? 1 : -1;
    return {
      x: start.x + sign * finalDist,
      y: start.y,
    };
  }

  const isVertical = Math.abs(Math.cos(snappedAngle)) < 1e-4;
  if (isVertical) {
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
    return `${(cm / 100).toFixed(2)} m`;
  }
  const totalInches = cm / 2.54;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  return `${feet}' ${inches}"`;
}
