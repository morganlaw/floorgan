import { CustomShapeKind, Point } from '../types';

export type BasicShapeKind = Exclude<CustomShapeKind, 'polygon'>;

export const BASIC_SHAPES: { id: BasicShapeKind; label: string }[] = [
  { id: 'rect', label: 'Rectangle' },
  { id: 'rounded_rect', label: 'Rounded' },
  { id: 'ellipse', label: 'Circle / Oval' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'right_triangle', label: 'Right Triangle' },
  { id: 'l_shape', label: 'L-Shape' },
  { id: 'u_shape', label: 'U-Shape' },
  { id: 'pentagon', label: 'Pentagon' },
  { id: 'hexagon', label: 'Hexagon' },
  { id: 'octagon', label: 'Octagon' },
];

const regularPolygon = (sides: number, rotationOffset = -Math.PI / 2): Point[] =>
  Array.from({ length: sides }, (_, i) => {
    const a = rotationOffset + (i * 2 * Math.PI) / sides;
    return { x: Math.cos(a) * 0.5, y: Math.sin(a) * 0.5 };
  });

/**
 * Returns normalized polygon vertices in [-0.5, 0.5] for polygonal shapes.
 * Returns null for shapes rendered as native SVG primitives (rect, rounded rect, ellipse).
 */
export function getNormalizedShapePoints(
  shape: CustomShapeKind | undefined,
  points?: Point[]
): Point[] | null {
  switch (shape) {
    case 'polygon':
      return points && points.length >= 3 ? points : null;
    case 'triangle':
      return [
        { x: 0, y: -0.5 },
        { x: 0.5, y: 0.5 },
        { x: -0.5, y: 0.5 },
      ];
    case 'right_triangle':
      return [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: 0.5 },
        { x: -0.5, y: 0.5 },
      ];
    case 'l_shape':
      return [
        { x: -0.5, y: -0.5 },
        { x: -0.1, y: -0.5 },
        { x: -0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.5 },
        { x: -0.5, y: 0.5 },
      ];
    case 'u_shape':
      return [
        { x: -0.5, y: -0.5 },
        { x: -0.2, y: -0.5 },
        { x: -0.2, y: 0.15 },
        { x: 0.2, y: 0.15 },
        { x: 0.2, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: 0.5, y: 0.5 },
        { x: -0.5, y: 0.5 },
      ];
    case 'pentagon':
      return regularPolygon(5);
    case 'hexagon':
      return regularPolygon(6, 0);
    case 'octagon':
      return regularPolygon(8, Math.PI / 8);
    default:
      return null;
  }
}

/** Scales normalized points to an SVG `points` attribute string. */
export function toSvgPoints(points: Point[], width: number, depth: number): string {
  return points.map((p) => `${(p.x * width).toFixed(2)},${(p.y * depth).toFixed(2)}`).join(' ');
}

/**
 * Normalizes absolute (cm) vertices to [-0.5, 0.5] around their bounding box center.
 * Returns the bounding box width/depth alongside.
 */
export function normalizePolygon(abs: Point[]): { points: Point[]; width: number; depth: number } {
  const xs = abs.map((p) => p.x);
  const ys = abs.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(maxX - minX, 1);
  const depth = Math.max(maxY - minY, 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    width,
    depth,
    points: abs.map((p) => ({
      x: +((p.x - cx) / width).toFixed(5),
      y: +((p.y - cy) / depth).toFixed(5),
    })),
  };
}
