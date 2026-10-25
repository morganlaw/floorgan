import React from 'react';
import { CustomShapeKind, Point } from '../types';
import { getNormalizedShapePoints, toSvgPoints } from '../utils/shapes';

interface ShapeBodyProps {
  shape?: CustomShapeKind;
  points?: Point[];
  width: number;
  depth: number;
  fill: string;
  fillOpacity?: number | string;
  stroke?: string;
  strokeWidth?: number | string;
}

/** Renders a custom shape centered at (0, 0) and scaled to width × depth. */
export const ShapeBody: React.FC<ShapeBodyProps> = ({
  shape = 'rect',
  points,
  width,
  depth,
  fill,
  fillOpacity = 0.88,
  stroke = '#0f172a',
  strokeWidth = 1.5,
}) => {
  const common = { fill, fillOpacity, stroke, strokeWidth, strokeLinejoin: 'round' as const };

  if (shape === 'ellipse') {
    return <ellipse cx={0} cy={0} rx={width / 2} ry={depth / 2} {...common} />;
  }

  const poly = getNormalizedShapePoints(shape, points);
  if (poly) {
    return <polygon points={toSvgPoints(poly, width, depth)} {...common} />;
  }

  const rx = shape === 'rounded_rect' ? Math.min(width, depth) * 0.18 : 0;
  return <rect x={-width / 2} y={-depth / 2} width={width} height={depth} rx={rx} {...common} />;
};

/** Small, fixed-size thumbnail of a shape for catalog cards and pickers. */
export const ShapeThumbnail: React.FC<{
  shape?: CustomShapeKind;
  points?: Point[];
  width: number;
  depth: number;
  color: string;
  size?: number;
}> = ({ shape, points, width, depth, color, size = 36 }) => {
  const pad = 3;
  const avail = size - pad * 2;
  const scale = avail / Math.max(width, depth, 1);
  const w = Math.max(width * scale, 4);
  const d = Math.max(depth * scale, 4);
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}>
      <ShapeBody
        shape={shape}
        points={points}
        width={w}
        depth={d}
        fill={color}
        fillOpacity={0.9}
        stroke="#0f172a"
        strokeWidth={1}
      />
    </svg>
  );
};
