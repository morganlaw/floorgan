import Tesseract from 'tesseract.js';
import {
  Wall,
  Door,
  WindowItem,
  PlacedFurniture,
  FloorplanState,
  RoomLabel,
  Unit,
} from '../types';

export interface ParseOptions {
  /** 0 = Auto (Otsu threshold), 1..250 = manual darkness threshold */
  threshold: number;
  /** Minimum wall thickness in processing pixels (filters thin text, dimension lines, furniture outlines) */
  minWallThicknessPx: number;
  /** Minimum wall segment length in cm */
  minWallLengthCm: number;
  /** Target real-world width of the floorplan bounding box in meters */
  targetWidthMeters: number;
  /** Fill double-line hollow walls before erosion */
  closeHollowWalls: boolean;
  /** Detect doors and windows in collinear wall gaps */
  detectOpenings: boolean;
  /** Invert image brightness (for light-on-dark CAD blueprints) */
  invert: boolean;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  threshold: 0,
  minWallThicknessPx: 3,
  minWallLengthCm: 70,
  targetWidthMeters: 10,
  closeHollowWalls: true,
  detectOpenings: true,
  invert: false,
};

export interface DetectedDimension {
  rawText: string;
  kind: 'pair' | 'single';
  unit: Unit;
  widthCm: number;
  heightCm?: number;
  /** Center position in floorplan world coordinates (cm) */
  xCm: number;
  yCm: number;
  /** Matched enclosing room or wall span in processing pixels */
  matchedSpanPx?: { x1: number; y1: number; x2: number; y2: number };
  /** Implied cm-per-pixel scale ratio from this dimension */
  impliedCmPerPx?: number;
}

export interface RawDimensionCandidate {
  rawText: string;
  kind: 'pair' | 'single';
  unit: Unit;
  val1Cm: number;
  val2Cm?: number;
  /** Center in processing canvas pixels (0..procW, 0..procH) */
  cxPx: number;
  cyPx: number;
}

export interface RawRoomNameCandidate {
  name: string;
  cxPx: number;
  cyPx: number;
}

export interface ParseResult {
  walls: Wall[];
  doors: Door[];
  windows: WindowItem[];
  furniture: PlacedFurniture[];
  roomLabels: RoomLabel[];
  maskPreviewDataUrl: string;
  computedThreshold: number;
  originOffset: { x: number; y: number };
  boundsCm: { width: number; height: number };
  detectedDimensions: DetectedDimension[];
  autoCalibratedWidthMeters: number | null;
  detectedUnit: Unit | null;
}

interface RawSegment {
  axis: 'h' | 'v';
  /** Fixed coordinate (y for 'h', x for 'v') in px or cm */
  pos: number;
  /** Start along axis (x1 for 'h', y1 for 'v') in px or cm */
  start: number;
  /** End along axis (x2 for 'h', y2 for 'v') in px or cm */
  end: number;
  /** Measured thickness in px or cm */
  thickness: number;
}

const ORIGIN_OFFSET_X = 100;
const ORIGIN_OFFSET_Y = 100;
const MAX_PROC_DIM = 680;

/**
 * Computes Otsu's optimal binarization threshold (0..255) on a grayscale array.
 */
function computeOtsuThreshold(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  const total = gray.length;
  for (let i = 0; i < total; i++) {
    hist[gray[i]]++;
  }

  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let bestThreshold = 160;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > maxVariance) {
      maxVariance = variance;
      bestThreshold = t;
    }
  }

  return Math.min(Math.max(bestThreshold, 60), 225);
}

/**
 * 1D horizontal + vertical morphological closing to fill narrow hollow gaps inside double-line CAD walls.
 */
function closeDoubleLineGaps(
  mask: Uint8Array,
  w: number,
  h: number,
  maxGap: number
): Uint8Array {
  const out = new Uint8Array(mask);

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    let lastOn = -1;
    for (let x = 0; x < w; x++) {
      if (mask[rowOffset + x]) {
        if (lastOn >= 0 && x - lastOn > 1 && x - lastOn <= maxGap) {
          for (let fillX = lastOn + 1; fillX < x; fillX++) {
            out[rowOffset + fillX] = 1;
          }
        }
        lastOn = x;
      }
    }
  }

  const finalOut = new Uint8Array(out);
  for (let x = 0; x < w; x++) {
    let lastOn = -1;
    for (let y = 0; y < h; y++) {
      if (out[y * w + x]) {
        if (lastOn >= 0 && y - lastOn > 1 && y - lastOn <= maxGap) {
          for (let fillY = lastOn + 1; fillY < y; fillY++) {
            finalOut[fillY * w + x] = 1;
          }
        }
        lastOn = y;
      }
    }
  }

  return finalOut;
}

/**
 * Separable box erosion followed by box dilation (morphological opening).
 * Strips away thin lines (text, dimension lines, door swing arcs, furniture icons)
 * while preserving structural walls of thickness >= kernelSize.
 */
function morphologicalOpen(
  mask: Uint8Array,
  w: number,
  h: number,
  kernelSize: number
): Uint8Array {
  if (kernelSize <= 1) return new Uint8Array(mask);
  const r = Math.floor(kernelSize / 2);

  // Erode horizontally
  const temp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = r; x < w - r; x++) {
      let allOn = 1;
      for (let dx = -r; dx <= r; dx++) {
        if (!mask[row + x + dx]) {
          allOn = 0;
          break;
        }
      }
      temp[row + x] = allOn;
    }
  }

  // Erode vertically
  const eroded = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let allOn = 1;
      for (let dy = -r; dy <= r; dy++) {
        if (!temp[(y + dy) * w + x]) {
          allOn = 0;
          break;
        }
      }
      eroded[row + x] = allOn;
    }
  }

  // Dilate horizontally
  const tempDilate = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = r; x < w - r; x++) {
      let anyOn = 0;
      for (let dx = -r; dx <= r; dx++) {
        if (eroded[row + x + dx]) {
          anyOn = 1;
          break;
        }
      }
      tempDilate[row + x] = anyOn;
    }
  }

  // Dilate vertically
  const opened = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let anyOn = 0;
      for (let dy = -r; dy <= r; dy++) {
        if (tempDilate[(y + dy) * w + x]) {
          anyOn = 1;
          break;
        }
      }
      opened[row + x] = anyOn;
    }
  }

  return opened;
}

/**
 * Extracts directional wall bands (horizontal & vertical) from the cleaned binary wall mask.
 */
function extractDirectionalWallSegments(
  wallMask: Uint8Array,
  w: number,
  h: number,
  minLengthPx: number,
  minThicknessPx: number
): RawSegment[] {
  const maxWallThicknessPx = Math.max(26, Math.round(Math.min(w, h) * 0.06));

  const vThick = new Uint16Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!wallMask[y * w + x]) {
        y++;
        continue;
      }
      let yEnd = y;
      while (yEnd < h && wallMask[yEnd * w + x]) yEnd++;
      const runLen = yEnd - y;
      for (let k = y; k < yEnd; k++) {
        vThick[k * w + x] = runLen;
      }
      y = yEnd;
    }
  }

  const hThick = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!wallMask[row + x]) {
        x++;
        continue;
      }
      let xEnd = x;
      while (xEnd < w && wallMask[row + xEnd]) xEnd++;
      const runLen = xEnd - x;
      for (let k = x; k < xEnd; k++) {
        hThick[row + k] = runLen;
      }
      x = xEnd;
    }
  }

  const hRowSegments: RawSegment[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!wallMask[row + x]) {
        x++;
        continue;
      }
      let xEnd = x;
      let validCount = 0;
      let thickSum = 0;
      while (xEnd < w && wallMask[row + xEnd]) {
        const vt = vThick[row + xEnd];
        if (vt >= minThicknessPx && vt <= maxWallThicknessPx) {
          validCount++;
          thickSum += vt;
        }
        xEnd++;
      }
      const len = xEnd - x;
      if (len >= minLengthPx && validCount >= len * 0.45) {
        hRowSegments.push({
          axis: 'h',
          pos: y,
          start: x,
          end: xEnd - 1,
          thickness: validCount > 0 ? thickSum / validCount : minThicknessPx,
        });
      }
      x = y === -1 ? 0 : xEnd;
    }
  }

  const vColSegments: RawSegment[] = [];
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!wallMask[y * w + x]) {
        y++;
        continue;
      }
      let yEnd = y;
      let validCount = 0;
      let thickSum = 0;
      while (yEnd < h && wallMask[yEnd * w + x]) {
        const ht = hThick[yEnd * w + x];
        if (ht >= minThicknessPx && ht <= maxWallThicknessPx) {
          validCount++;
          thickSum += ht;
        }
        yEnd++;
      }
      const len = yEnd - y;
      if (len >= minLengthPx && validCount >= len * 0.45) {
        vColSegments.push({
          axis: 'v',
          pos: x,
          start: y,
          end: yEnd - 1,
          thickness: validCount > 0 ? thickSum / validCount : minThicknessPx,
        });
      }
      y = yEnd;
    }
  }

  return [
    ...clusterAdjacentSlices(hRowSegments, 'h'),
    ...clusterAdjacentSlices(vColSegments, 'v'),
  ];
}

function clusterAdjacentSlices(slices: RawSegment[], axis: 'h' | 'v'): RawSegment[] {
  const sorted = [...slices].sort((a, b) => a.pos - b.pos || a.start - b.start);
  const clusters: {
    posSum: number;
    weightSum: number;
    lastPos: number;
    firstPos: number;
    start: number;
    end: number;
    count: number;
  }[] = [];

  for (const seg of sorted) {
    const segLen = seg.end - seg.start;
    let matched = false;
    for (let i = clusters.length - 1; i >= 0; i--) {
      const c = clusters[i];
      if (seg.pos - c.lastPos > 3) continue;
      const overlap = Math.min(c.end, seg.end) - Math.max(c.start, seg.start);
      const minSpan = Math.min(c.end - c.start, segLen);
      if (overlap >= minSpan * 0.4) {
        c.posSum += seg.pos * segLen;
        c.weightSum += segLen;
        c.lastPos = seg.pos;
        c.start = Math.min(c.start, seg.start);
        c.end = Math.max(c.end, seg.end);
        c.count++;
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.push({
        posSum: seg.pos * segLen,
        weightSum: segLen,
        firstPos: seg.pos,
        lastPos: seg.pos,
        start: seg.start,
        end: seg.end,
        count: 1,
      });
    }
  }

  return clusters.map((c) => ({
    axis,
    pos: Math.round(c.posSum / Math.max(1, c.weightSum)),
    start: c.start,
    end: c.end,
    thickness: Math.max(2, c.lastPos - c.firstPos + 1),
  }));
}

/**
 * Parses architectural dimension strings from OCR text lines/words into centimeters.
 * Supports:
 * - Metric pairs: "5.2m x 3.8m", "5.20 x 3.80 m", "520 x 380 cm", "5200 x 3800 mm", "4.2 x 3.5"
 * - Imperial pairs: "12' 6\" x 14' 2\"", "12'-6\" x 14'-2\"", "12' x 14'", "12.5' x 15'"
 * - Single wall callouts: "5.2m", "420 cm", "14' 6\"", "16.5 ft"
 */
export function parseDimensionText(
  text: string
): { kind: 'pair' | 'single'; unit: Unit; val1Cm: number; val2Cm?: number; matchedText: string } | null {
  const cleaned = text
    .replace(/[×✕＊*]/g, 'x')
    .replace(/[""״]/g, '"')
    .replace(/[''′´`]/g, "'")
    .trim();

  // 1. Imperial feet/inches pair: e.g. 12' 6" x 14' 0" or 12' x 15' or 12'-6" x 14'-2"
  const impPairRegex =
    /(\d{1,2})\s*'\s*(?:-\s*)?(?:(\d{1,2})\s*"?)?\s*[xX]\s*(\d{1,2})\s*'\s*(?:-\s*)?(?:(\d{1,2})\s*"?)?/;
  const impPairMatch = cleaned.match(impPairRegex);
  if (impPairMatch) {
    const ft1 = parseInt(impPairMatch[1], 10);
    const in1 = impPairMatch[2] ? parseInt(impPairMatch[2], 10) : 0;
    const ft2 = parseInt(impPairMatch[3], 10);
    const in2 = impPairMatch[4] ? parseInt(impPairMatch[4], 10) : 0;
    const cm1 = Math.round((ft1 * 12 + in1) * 2.54);
    const cm2 = Math.round((ft2 * 12 + in2) * 2.54);
    if (cm1 >= 90 && cm1 <= 2500 && cm2 >= 90 && cm2 <= 2500) {
      return {
        kind: 'pair',
        unit: 'ft',
        val1Cm: cm1,
        val2Cm: cm2,
        matchedText: impPairMatch[0].trim(),
      };
    }
  }

  // 2. Metric or decimal pair: e.g. "5.2m x 3.8m", "5.20 x 3.80m", "520 x 380 cm", "4.5 x 3.2"
  const metricPairRegex =
    /(\d{1,4}(?:[.,]\d{1,2})?)\s*(mm|cm|m|ft|')?\s*[xX]\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(mm|cm|m|ft|')?/i;
  const metricPairMatch = cleaned.match(metricPairRegex);
  if (metricPairMatch) {
    const raw1 = parseFloat(metricPairMatch[1].replace(',', '.'));
    const u1 = (metricPairMatch[2] || '').toLowerCase();
    const raw2 = parseFloat(metricPairMatch[3].replace(',', '.'));
    const u2 = (metricPairMatch[4] || '').toLowerCase();
    const unitToken = u1 || u2;

    let cm1 = 0;
    let cm2 = 0;
    let unit: Unit = 'm';

    if (unitToken === 'mm') {
      cm1 = raw1 / 10;
      cm2 = raw2 / 10;
    } else if (unitToken === 'cm') {
      cm1 = raw1;
      cm2 = raw2;
    } else if (unitToken === 'ft' || unitToken === "'") {
      cm1 = raw1 * 30.48;
      cm2 = raw2 * 30.48;
      unit = 'ft';
    } else if (unitToken === 'm') {
      cm1 = raw1 * 100;
      cm2 = raw2 * 100;
    } else {
      // Unitless pair heuristics:
      // - Decimals between 1.2 and 18.0 -> meters (e.g. "4.20 x 3.60")
      // - Integers between 120 and 1500 -> centimeters (e.g. "420 x 360")
      // - Integers between 1200 and 15000 -> millimeters (e.g. "4200 x 3600")
      // - Integers between 7 and 35 -> feet (e.g. "12 x 14")
      if (
        (metricPairMatch[1].includes('.') || metricPairMatch[3].includes('.')) &&
        raw1 >= 1.2 &&
        raw1 <= 20 &&
        raw2 >= 1.2 &&
        raw2 <= 20
      ) {
        cm1 = raw1 * 100;
        cm2 = raw2 * 100;
      } else if (raw1 >= 120 && raw1 <= 1500 && raw2 >= 120 && raw2 <= 1500) {
        cm1 = raw1;
        cm2 = raw2;
      } else if (raw1 >= 1200 && raw1 <= 15000 && raw2 >= 1200 && raw2 <= 15000) {
        cm1 = raw1 / 10;
        cm2 = raw2 / 10;
      } else if (raw1 >= 7 && raw1 <= 36 && raw2 >= 7 && raw2 <= 36) {
        cm1 = raw1 * 30.48;
        cm2 = raw2 * 30.48;
        unit = 'ft';
      }
    }

    if (cm1 >= 90 && cm1 <= 2500 && cm2 >= 90 && cm2 <= 2500) {
      return {
        kind: 'pair',
        unit,
        val1Cm: Math.round(cm1),
        val2Cm: Math.round(cm2),
        matchedText: metricPairMatch[0].trim(),
      };
    }
  }

  // 3. Single Imperial dimension callout: e.g. "14' 6\"" or "14'-6\""
  const impSingleRegex = /\b(\d{1,2})\s*'\s*(?:-\s*)?(\d{1,2})\s*"/;
  const impSingleMatch = cleaned.match(impSingleRegex);
  if (impSingleMatch) {
    const ft = parseInt(impSingleMatch[1], 10);
    const inches = parseInt(impSingleMatch[2], 10);
    const cm = Math.round((ft * 12 + inches) * 2.54);
    if (cm >= 90 && cm <= 2500) {
      return {
        kind: 'single',
        unit: 'ft',
        val1Cm: cm,
        matchedText: impSingleMatch[0].trim(),
      };
    }
  }

  // 4. Single Metric/Explicit-Unit dimension callout: e.g. "5.20 m", "450 cm", "4500 mm", "16.5 ft"
  const singleExplicitRegex = /\b(\d{1,4}(?:[.,]\d{1,2})?)\s*(mm|cm|m|ft)\b/i;
  const singleMatch = cleaned.match(singleExplicitRegex);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1].replace(',', '.'));
    const u = singleMatch[2].toLowerCase();
    let cm = 0;
    let unit: Unit = 'm';
    if (u === 'mm') cm = val / 10;
    else if (u === 'cm') cm = val;
    else if (u === 'm') cm = val * 100;
    else if (u === 'ft') {
      cm = val * 30.48;
      unit = 'ft';
    }
    if (cm >= 100 && cm <= 2500) {
      return {
        kind: 'single',
        unit,
        val1Cm: Math.round(cm),
        matchedText: singleMatch[0].trim(),
      };
    }
  }

  return null;
}

/**
 * Deterministically matches OCR dimension candidates against the extracted pixel wall geometry
 * using 4-directional ray casting (for room WxH pairs) and nearest-wall projection (for single wall labels).
 */
function matchDimensionsToPixelWalls(
  candidates: RawDimensionCandidate[],
  rawSegmentsPx: RawSegment[],
  spanPxW: number
): {
  matched: DetectedDimension[];
  calibratedWidthMeters: number | null;
  detectedUnit: Unit | null;
  cmPerPx: number | null;
} {
  if (candidates.length === 0 || rawSegmentsPx.length === 0) {
    return {
      matched: [],
      calibratedWidthMeters: null,
      detectedUnit: null,
      cmPerPx: null,
    };
  }

  const hWalls = rawSegmentsPx.filter((s) => s.axis === 'h');
  const vWalls = rawSegmentsPx.filter((s) => s.axis === 'v');

  const scaleSamples: number[] = [];
  const prelimMatched: {
    cand: RawDimensionCandidate;
    matchedSpanPx?: { x1: number; y1: number; x2: number; y2: number };
    impliedCmPerPx?: number;
  }[] = [];

  for (const cand of candidates) {
    const { cxPx, cyPx } = cand;

    if (cand.kind === 'pair' && cand.val2Cm) {
      // Cast rays left, right, up, down from (cxPx, cyPx) to find enclosing room walls
      let leftWall: RawSegment | null = null;
      let rightWall: RawSegment | null = null;
      let topWall: RawSegment | null = null;
      let bottomWall: RawSegment | null = null;

      const marginPx = 25;

      for (const vw of vWalls) {
        if (cyPx >= vw.start - marginPx && cyPx <= vw.end + marginPx) {
          if (vw.pos < cxPx && (!leftWall || vw.pos > leftWall.pos)) {
            leftWall = vw;
          }
          if (vw.pos > cxPx && (!rightWall || vw.pos < rightWall.pos)) {
            rightWall = vw;
          }
        }
      }

      for (const hw of hWalls) {
        if (cxPx >= hw.start - marginPx && cxPx <= hw.end + marginPx) {
          if (hw.pos < cyPx && (!topWall || hw.pos > topWall.pos)) {
            topWall = hw;
          }
          if (hw.pos > cyPx && (!bottomWall || hw.pos < bottomWall.pos)) {
            bottomWall = hw;
          }
        }
      }

      const roomW = leftWall && rightWall ? rightWall.pos - leftWall.pos : 0;
      const roomH = topWall && bottomWall ? bottomWall.pos - topWall.pos : 0;

      if (roomW > 30 && roomH > 30) {
        // Check direct (val1 -> W, val2 -> H) vs transposed (val2 -> W, val1 -> H)
        const directRatioX = cand.val1Cm / roomW;
        const directRatioY = cand.val2Cm / roomH;
        const directDiff = Math.abs(directRatioX - directRatioY) / Math.max(directRatioX, directRatioY);

        const swappedRatioX = cand.val2Cm / roomW;
        const swappedRatioY = cand.val1Cm / roomH;
        const swappedDiff =
          Math.abs(swappedRatioX - swappedRatioY) / Math.max(swappedRatioX, swappedRatioY);

        const bestDiff = Math.min(directDiff, swappedDiff);
        const avgScale =
          directDiff <= swappedDiff
            ? (directRatioX + directRatioY) / 2
            : (swappedRatioX + swappedRatioY) / 2;

        if (bestDiff < 0.35 && avgScale >= 0.2 && avgScale <= 15) {
          scaleSamples.push(avgScale);
          prelimMatched.push({
            cand,
            matchedSpanPx: {
              x1: leftWall!.pos,
              y1: topWall!.pos,
              x2: rightWall!.pos,
              y2: bottomWall!.pos,
            },
            impliedCmPerPx: avgScale,
          });
          continue;
        }
      }

      if (roomW > 30) {
        const scale = cand.val1Cm / roomW;
        if (scale >= 0.2 && scale <= 15) {
          scaleSamples.push(scale);
          prelimMatched.push({
            cand,
            matchedSpanPx: {
              x1: leftWall!.pos,
              y1: cyPx - 10,
              x2: rightWall!.pos,
              y2: cyPx + 10,
            },
            impliedCmPerPx: scale,
          });
          continue;
        }
      }
    } else if (cand.kind === 'single') {
      // Find nearest wall segment whose span covers the label
      let bestWall: RawSegment | null = null;
      let bestDist = 80;

      for (const hw of hWalls) {
        if (cxPx >= hw.start - 15 && cxPx <= hw.end + 15) {
          const d = Math.abs(cyPx - hw.pos);
          if (d < bestDist && hw.end - hw.start > 30) {
            bestDist = d;
            bestWall = hw;
          }
        }
      }
      for (const vw of vWalls) {
        if (cyPx >= vw.start - 15 && cyPx <= vw.end + 15) {
          const d = Math.abs(cxPx - vw.pos);
          if (d < bestDist && vw.end - vw.start > 30) {
            bestDist = d;
            bestWall = vw;
          }
        }
      }

      if (bestWall) {
        const lenPx = bestWall.end - bestWall.start;
        const scale = cand.val1Cm / lenPx;
        if (scale >= 0.2 && scale <= 15) {
          scaleSamples.push(scale);
          prelimMatched.push({
            cand,
            matchedSpanPx:
              bestWall.axis === 'h'
                ? { x1: bestWall.start, y1: bestWall.pos, x2: bestWall.end, y2: bestWall.pos }
                : { x1: bestWall.pos, y1: bestWall.start, x2: bestWall.pos, y2: bestWall.end },
            impliedCmPerPx: scale,
          });
          continue;
        }
      }
    }

    prelimMatched.push({ cand });
  }

  let medianCmPerPx: number | null = null;
  if (scaleSamples.length > 0) {
    const sorted = [...scaleSamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianCmPerPx =
      sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const calibratedWidthMeters =
    medianCmPerPx !== null
      ? Math.round(((spanPxW * medianCmPerPx) / 100) * 100) / 100
      : null;

  const detectedUnit: Unit | null =
    candidates.length > 0 ? candidates[0].unit : null;

  const finalScale = medianCmPerPx || 1;
  const matched: DetectedDimension[] = prelimMatched.map((item) => ({
    rawText: item.cand.rawText,
    kind: item.cand.kind,
    unit: item.cand.unit,
    widthCm: item.cand.val1Cm,
    heightCm: item.cand.val2Cm,
    xCm: Math.round(item.cand.cxPx * finalScale + ORIGIN_OFFSET_X),
    yCm: Math.round(item.cand.cyPx * finalScale + ORIGIN_OFFSET_Y),
    matchedSpanPx: item.matchedSpanPx,
    impliedCmPerPx: item.impliedCmPerPx,
  }));

  return {
    matched,
    calibratedWidthMeters,
    detectedUnit,
    cmPerPx: medianCmPerPx,
  };
}

/**
 * Recognizes standard architectural room names from OCR text lines.
 */
export function parseRoomNameText(text: string): string | null {
  const cleaned = text.replace(/[^a-zA-Z0-9 &/.-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 3) return null;

  const roomPatterns: [RegExp, string][] = [
    [/\b(primary|master|main)\s+bed(room)?\b/i, 'Primary Bedroom'],
    [/\bbed(room)?\s*\d*\b/i, 'Bedroom'],
    [/\bliving\s*(&|and|\/)?\s*dining\b/i, 'Living & Dining'],
    [/\bliving(\s+room|\s+area)?\b/i, 'Living Room'],
    [/\bdining(\s+room|\s+area)?\b/i, 'Dining Room'],
    [/\bkitchen(ette)?\b/i, 'Kitchen'],
    [/\bbath(room)?\s*\d*\b/i, 'Bathroom'],
    [/\b(restroom|powder\s*room|wc)\b/i, 'Bathroom'],
    [/\b(home\s+)?(office|study|den)\b/i, 'Office'],
    [/\b(walk[- ]?in\s+)?closet\b/i, 'Closet'],
    [/\b(foyer|entry(way)?|vestibule)\b/i, 'Entry / Foyer'],
    [/\b(balcony|terrace|patio|deck)\b/i, 'Balcony'],
    [/\b(laundry|utility)\b/i, 'Laundry'],
    [/\b(hall(way)?|corridor)\b/i, 'Hallway'],
    [/\bgarage\b/i, 'Garage'],
    [/\bstudio\b/i, 'Studio'],
  ];

  for (const [regex, canonicalName] of roomPatterns) {
    if (regex.test(cleaned)) {
      return canonicalName;
    }
  }
  return null;
}

/**
 * Runs client-side Tesseract OCR on the floorplan image and extracts both
 * printed dimension strings ("5.2m x 3.4m") and room name labels ("Bedroom", "Kitchen", "Bathroom").
 */
export async function extractOcrDimensionsFromImage(
  img: HTMLImageElement,
  invert = false
): Promise<{ dimensions: RawDimensionCandidate[]; roomNames: RawRoomNameCandidate[] }> {
  const naturalW = img.naturalWidth || img.width || 600;
  const naturalH = img.naturalHeight || img.height || 450;

  const ocrScale = Math.min(2.0, 1400 / Math.max(naturalW, naturalH));
  const ocrW = Math.max(120, Math.round(naturalW * ocrScale));
  const ocrH = Math.max(120, Math.round(naturalH * ocrScale));

  const procDownscale = Math.min(1, MAX_PROC_DIM / Math.max(naturalW, naturalH));
  const procW = Math.max(64, Math.round(naturalW * procDownscale));
  const procH = Math.max(64, Math.round(naturalH * procDownscale));

  const canvas = document.createElement('canvas');
  canvas.width = ocrW;
  canvas.height = ocrH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ocrW, ocrH);
  ctx.drawImage(img, 0, 0, ocrW, ocrH);

  if (invert) {
    const data = ctx.getImageData(0, 0, ocrW, ocrH);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i] = 255 - data.data[i];
      data.data[i + 1] = 255 - data.data[i + 1];
      data.data[i + 2] = 255 - data.data[i + 2];
    }
    ctx.putImageData(data, 0, 0);
  }

  const worker = await Tesseract.createWorker('eng');
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
    });
    const result = await worker.recognize(canvas, {}, { blocks: true });
    const dimensions: RawDimensionCandidate[] = [];
    const roomNames: RawRoomNameCandidate[] = [];

    const blocks = result.data?.blocks || [];
    for (const block of blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          if (!line.bbox) continue;
          const cxPx = (((line.bbox.x0 + line.bbox.x1) / 2) / ocrW) * procW;
          const cyPx = (((line.bbox.y0 + line.bbox.y1) / 2) / ocrH) * procH;

          const parsedDim = parseDimensionText(line.text);
          if (parsedDim) {
            dimensions.push({
              rawText: parsedDim.matchedText,
              kind: parsedDim.kind,
              unit: parsedDim.unit,
              val1Cm: parsedDim.val1Cm,
              val2Cm: parsedDim.val2Cm,
              cxPx,
              cyPx,
            });
          }

          const parsedRoom = parseRoomNameText(line.text);
          if (parsedRoom) {
            roomNames.push({
              name: parsedRoom,
              cxPx,
              cyPx,
            });
          }
        }
      }
    }

    return { dimensions, roomNames };
  } finally {
    await worker.terminate();
  }
}

/**
 * Topological Graph Regularizer:
 * 1. Groups collinear wall segments along the same axis line.
 * 2. Detects doorway/window openings (55cm - 175cm gaps between collinear segments) and bridges the wall
 *    so doors/windows sit cleanly on top of continuous walls (matching FloorGAN's native model).
 * 3. Snaps perpendicular L, T, and + corner junctions so rooms form closed orthogonal polygons.
 */
export function regularizeFloorplanGraph(
  segmentsCm: RawSegment[],
  rawBinaryMask: Uint8Array | null,
  maskWidth: number,
  maskHeight: number,
  cmPerPx: number,
  minWallLengthCm: number,
  detectOpenings: boolean
): { walls: Wall[]; doors: Door[]; windows: WindowItem[] } {
  const collinearToleranceCm = 24;
  const smallGapBridgeCm = 35;
  const maxOpeningWidthCm = 175;
  const minOpeningWidthCm = 55;
  const cornerSnapToleranceCm = 36;

  const hSegs = segmentsCm.filter((s) => s.axis === 'h').sort((a, b) => a.pos - b.pos);
  const vSegs = segmentsCm.filter((s) => s.axis === 'v').sort((a, b) => a.pos - b.pos);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of segmentsCm) {
    if (s.axis === 'h') {
      minX = Math.min(minX, s.start);
      maxX = Math.max(maxX, s.end);
      minY = Math.min(minY, s.pos);
      maxY = Math.max(maxY, s.pos);
    } else {
      minY = Math.min(minY, s.start);
      maxY = Math.max(maxY, s.end);
      minX = Math.min(minX, s.pos);
      maxX = Math.max(maxX, s.pos);
    }
  }

  const doors: Door[] = [];
  const windows: WindowItem[] = [];

  function mergeAndExtractLineGroup(
    group: RawSegment[],
    axis: 'h' | 'v'
  ): RawSegment[] {
    if (group.length === 0) return [];
    let posWeight = 0;
    let totalWeight = 0;
    let thickSum = 0;
    for (const s of group) {
      const len = Math.max(1, s.end - s.start);
      posWeight += s.pos * len;
      totalWeight += len;
      thickSum += s.thickness * len;
    }
    const alignedPos = Math.round(posWeight / totalWeight);
    const avgThickness = Math.min(25, Math.max(12, Math.round(thickSum / totalWeight / 5) * 5));

    const sortedIntervals = [...group]
      .map((s) => ({ start: s.start, end: s.end }))
      .sort((a, b) => a.start - b.start);

    const merged: { start: number; end: number }[] = [];
    for (const interval of sortedIntervals) {
      if (merged.length === 0) {
        merged.push({ ...interval });
      } else {
        const prev = merged[merged.length - 1];
        if (interval.start - prev.end <= smallGapBridgeCm) {
          prev.end = Math.max(prev.end, interval.end);
        } else {
          merged.push({ ...interval });
        }
      }
    }

    if (!detectOpenings || merged.length <= 1) {
      return merged
        .filter((m) => m.end - m.start >= minWallLengthCm)
        .map((m) => ({
          axis,
          pos: alignedPos,
          start: m.start,
          end: m.end,
          thickness: avgThickness,
        }));
    }

    const bridged: { start: number; end: number }[] = [merged[0]];
    const isExteriorLine =
      axis === 'h'
        ? Math.abs(alignedPos - minY) < 40 || Math.abs(alignedPos - maxY) < 40
        : Math.abs(alignedPos - minX) < 40 || Math.abs(alignedPos - maxX) < 40;

    for (let i = 1; i < merged.length; i++) {
      const prev = bridged[bridged.length - 1];
      const curr = merged[i];
      const gapWidth = curr.start - prev.end;

      if (gapWidth >= minOpeningWidthCm && gapWidth <= maxOpeningWidthCm) {
        const gapCenter = Math.round((prev.end + curr.start) / 2);
        const clampedWidth = Math.round(Math.min(160, Math.max(70, gapWidth)) / 5) * 5;

        let rawDensity = 0;
        if (rawBinaryMask && cmPerPx > 0) {
          const pxPos = Math.round(alignedPos / cmPerPx);
          const pxStart = Math.round(prev.end / cmPerPx);
          const pxEnd = Math.round(curr.start / cmPerPx);
          let onCount = 0;
          let sampleCount = 0;
          for (let t = pxStart; t <= pxEnd; t++) {
            for (let d = -3; d <= 3; d++) {
              const rx = axis === 'h' ? t : pxPos + d;
              const ry = axis === 'h' ? pxPos + d : t;
              if (rx >= 0 && rx < maskWidth && ry >= 0 && ry < maskHeight) {
                sampleCount++;
                if (rawBinaryMask[ry * maskWidth + rx]) onCount++;
              }
            }
          }
          if (sampleCount > 0) rawDensity = onCount / sampleCount;
        }

        const isWindow = isExteriorLine && (rawDensity > 0.14 || gapWidth >= 110);
        if (isWindow) {
          windows.push({
            id: `win_imp_${windows.length + 1}_${Date.now().toString(36)}`,
            x: axis === 'h' ? gapCenter + ORIGIN_OFFSET_X : alignedPos + ORIGIN_OFFSET_X,
            y: axis === 'h' ? alignedPos + ORIGIN_OFFSET_Y : gapCenter + ORIGIN_OFFSET_Y,
            width: clampedWidth,
            thickness: avgThickness,
            rotation: axis === 'h' ? 0 : 90,
          });
        } else {
          doors.push({
            id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
            x: axis === 'h' ? gapCenter + ORIGIN_OFFSET_X : alignedPos + ORIGIN_OFFSET_X,
            y: axis === 'h' ? alignedPos + ORIGIN_OFFSET_Y : gapCenter + ORIGIN_OFFSET_Y,
            width: Math.min(95, Math.max(75, clampedWidth)),
            rotation: axis === 'h' ? 0 : 90,
            swingDirection: 'left',
          });
        }

        prev.end = curr.end;
      } else {
        bridged.push(curr);
      }
    }

    return bridged
      .filter((m) => m.end - m.start >= minWallLengthCm)
      .map((m) => ({
        axis,
        pos: alignedPos,
        start: m.start,
        end: m.end,
        thickness: avgThickness,
      }));
  }

  function groupCollinear(segs: RawSegment[], axis: 'h' | 'v'): RawSegment[] {
    const result: RawSegment[] = [];
    let currentGroup: RawSegment[] = [];

    for (const seg of segs) {
      if (currentGroup.length === 0) {
        currentGroup.push(seg);
      } else {
        const groupAvgPos =
          currentGroup.reduce((acc, item) => acc + item.pos, 0) / currentGroup.length;
        if (Math.abs(seg.pos - groupAvgPos) <= collinearToleranceCm) {
          currentGroup.push(seg);
        } else {
          result.push(...mergeAndExtractLineGroup(currentGroup, axis));
          currentGroup = [seg];
        }
      }
    }
    if (currentGroup.length > 0) {
      result.push(...mergeAndExtractLineGroup(currentGroup, axis));
    }
    return result;
  }

  const cleanH = groupCollinear(hSegs, 'h');
  const cleanV = groupCollinear(vSegs, 'v');

  // Snap orthogonal L-corners and T-junctions between cleanH and cleanV
  for (const h of cleanH) {
    for (const v of cleanV) {
      const hNearVYRange =
        h.pos >= v.start - cornerSnapToleranceCm && h.pos <= v.end + cornerSnapToleranceCm;
      if (hNearVYRange) {
        if (Math.abs(h.start - v.pos) <= cornerSnapToleranceCm) {
          h.start = v.pos;
        }
        if (Math.abs(h.end - v.pos) <= cornerSnapToleranceCm) {
          h.end = v.pos;
        }
      }

      const vNearHXRange =
        v.pos >= h.start - cornerSnapToleranceCm && v.pos <= h.end + cornerSnapToleranceCm;
      if (vNearHXRange) {
        if (Math.abs(v.start - h.pos) <= cornerSnapToleranceCm) {
          v.start = h.pos;
        }
        if (Math.abs(v.end - h.pos) <= cornerSnapToleranceCm) {
          v.end = h.pos;
        }
      }
    }
  }

  const walls: Wall[] = [];
  let wallIdx = 1;

  for (const h of cleanH) {
    if (h.end - h.start < minWallLengthCm * 0.7) continue;
    walls.push({
      id: `w_imp_${wallIdx++}`,
      start: { x: Math.round(h.start + ORIGIN_OFFSET_X), y: Math.round(h.pos + ORIGIN_OFFSET_Y) },
      end: { x: Math.round(h.end + ORIGIN_OFFSET_X), y: Math.round(h.pos + ORIGIN_OFFSET_Y) },
      thickness: h.thickness,
    });
  }

  for (const v of cleanV) {
    if (v.end - v.start < minWallLengthCm * 0.7) continue;
    walls.push({
      id: `w_imp_${wallIdx++}`,
      start: { x: Math.round(v.pos + ORIGIN_OFFSET_X), y: Math.round(v.start + ORIGIN_OFFSET_Y) },
      end: { x: Math.round(v.pos + ORIGIN_OFFSET_X), y: Math.round(v.end + ORIGIN_OFFSET_Y) },
      thickness: v.thickness,
    });
  }

  return { walls, doors, windows };
}

/**
 * Deterministic Raster-to-Vector Floorplan Parser.
 * Takes an HTMLImageElement, ParseOptions, and optional OCR dimension candidates.
 * If OCR dimensions are present and match enclosing room/wall spans, automatically calibrates scale!
 */
export function parseFloorplanImage(
  img: HTMLImageElement,
  options: ParseOptions,
  ocrCandidates: RawDimensionCandidate[] = [],
  useOcrScale = true,
  roomCandidates: RawRoomNameCandidate[] = []
): ParseResult {
  const naturalW = img.naturalWidth || img.width || 600;
  const naturalH = img.naturalHeight || img.height || 450;

  const downscale = Math.min(1, MAX_PROC_DIM / Math.max(naturalW, naturalH));
  const w = Math.max(64, Math.round(naturalW * downscale));
  const h = Math.max(64, Math.round(naturalH * downscale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  const rgba = imgData.data;
  const gray = new Uint8Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a < 50) {
      gray[i] = options.invert ? 0 : 255;
    } else {
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[i] = options.invert ? 255 - lum : lum;
    }
  }

  const computedThreshold =
    options.threshold > 0 ? options.threshold : computeOtsuThreshold(gray);

  const rawMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    rawMask[i] = gray[i] < computedThreshold ? 1 : 0;
  }

  const closedMask = options.closeHollowWalls
    ? closeDoubleLineGaps(rawMask, w, h, Math.max(4, options.minWallThicknessPx * 2))
    : rawMask;

  const structuralMask = morphologicalOpen(
    closedMask,
    w,
    h,
    options.minWallThicknessPx
  );

  let minPxX = w;
  let maxPxX = 0;
  let minPxY = h;
  let maxPxY = 0;
  let activeCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (structuralMask[y * w + x]) {
        if (x < minPxX) minPxX = x;
        if (x > maxPxX) maxPxX = x;
        if (y < minPxY) minPxY = y;
        if (y > maxPxY) maxPxY = y;
        activeCount++;
      }
    }
  }

  if (activeCount < 20) {
    minPxX = 0;
    maxPxX = w;
    minPxY = 0;
    maxPxY = h;
  }

  const spanPxW = Math.max(50, maxPxX - minPxX);

  const prelimSegmentsPx = extractDirectionalWallSegments(
    structuralMask,
    w,
    h,
    14,
    Math.max(1, options.minWallThicknessPx - 1)
  );

  const ocrMatch = matchDimensionsToPixelWalls(
    ocrCandidates,
    prelimSegmentsPx,
    spanPxW
  );

  const effectiveWidthMeters =
    useOcrScale && ocrMatch.calibratedWidthMeters !== null
      ? ocrMatch.calibratedWidthMeters
      : options.targetWidthMeters;

  const targetWidthCm = Math.max(200, effectiveWidthMeters * 100);
  const cmPerPx =
    useOcrScale && ocrMatch.cmPerPx !== null
      ? ocrMatch.cmPerPx
      : targetWidthCm / spanPxW;

  const minLengthPx = Math.max(12, Math.round(options.minWallLengthCm / cmPerPx));

  const rawSegmentsPx = extractDirectionalWallSegments(
    structuralMask,
    w,
    h,
    minLengthPx,
    Math.max(1, options.minWallThicknessPx - 1)
  );

  const segmentsCm: RawSegment[] = rawSegmentsPx.map((s) => ({
    axis: s.axis,
    pos: s.pos * cmPerPx,
    start: s.start * cmPerPx,
    end: s.end * cmPerPx,
    thickness: Math.max(10, Math.min(25, Math.round(s.thickness * cmPerPx))),
  }));

  const { walls, doors, windows } = regularizeFloorplanGraph(
    segmentsCm,
    rawMask,
    w,
    h,
    cmPerPx,
    options.minWallLengthCm,
    options.detectOpenings
  );

  // Update detected dimension world coordinates with final cmPerPx
  const detectedDimensions: DetectedDimension[] = ocrMatch.matched.map((d, idx) => ({
    ...d,
    xCm: Math.round(ocrCandidates[idx].cxPx * cmPerPx + ORIGIN_OFFSET_X),
    yCm: Math.round(ocrCandidates[idx].cyPx * cmPerPx + ORIGIN_OFFSET_Y),
  }));

  // Pair detected room names (e.g., "Living Room", "Bedroom", "Kitchen") with their nearest dimension label
  const roomLabels: RoomLabel[] = roomCandidates.map((rm, idx) => {
    let bestDimText: string | undefined;
    let bestDistPx = 90;
    for (const dim of ocrCandidates) {
      const dist = Math.hypot(dim.cxPx - rm.cxPx, dim.cyPx - rm.cyPx);
      if (dist < bestDistPx) {
        bestDistPx = dist;
        bestDimText = dim.rawText;
      }
    }
    return {
      id: `room_imp_${idx + 1}_${Date.now().toString(36)}`,
      name: rm.name,
      dimensionsText: bestDimText,
      x: Math.round(rm.cxPx * cmPerPx + ORIGIN_OFFSET_X),
      y: Math.round(rm.cyPx * cmPerPx + ORIGIN_OFFSET_Y),
    };
  });

  // Visual morphological mask preview
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = w;
  previewCanvas.height = h;
  const pCtx = previewCanvas.getContext('2d')!;
  const pData = pCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const isWall = structuralMask[i] === 1;
    const isRaw = rawMask[i] === 1;
    if (isWall) {
      pData.data[i * 4] = 30;
      pData.data[i * 4 + 1] = 64;
      pData.data[i * 4 + 2] = 175;
      pData.data[i * 4 + 3] = 255;
    } else if (isRaw) {
      pData.data[i * 4] = 203;
      pData.data[i * 4 + 1] = 213;
      pData.data[i * 4 + 2] = 225;
      pData.data[i * 4 + 3] = 255;
    } else {
      pData.data[i * 4] = 248;
      pData.data[i * 4 + 1] = 250;
      pData.data[i * 4 + 2] = 252;
      pData.data[i * 4 + 3] = 255;
    }
  }
  pCtx.putImageData(pData, 0, 0);

  return {
    walls,
    doors,
    windows,
    furniture: [],
    roomLabels,
    maskPreviewDataUrl: previewCanvas.toDataURL('image/png'),
    computedThreshold,
    originOffset: { x: ORIGIN_OFFSET_X, y: ORIGIN_OFFSET_Y },
    boundsCm: {
      width: Math.round(w * cmPerPx),
      height: Math.round(h * cmPerPx),
    },
    detectedDimensions,
    autoCalibratedWidthMeters: ocrMatch.calibratedWidthMeters,
    detectedUnit: ocrMatch.detectedUnit,
  };
}

/**
 * Fetches an image or extracts floorplan images from a website URL using CORS proxies
 * so static deployments (e.g., GitHub Pages) can import from external links.
 */
export async function fetchFloorplanFromUrl(rawUrl: string): Promise<{
  primaryDataUrl?: string;
  candidates: { url: string; label: string }[];
}> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('Please enter a valid URL.');

  if (trimmed.startsWith('data:image/')) {
    return { primaryDataUrl: trimmed, candidates: [] };
  }

  const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  const proxyGenerators = [
    (u: string) => u,
    (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];

  const isLikelyImageUrl = /\.(png|jpe?g|webp|gif|svg|bmp|avif)(\?.*)?$/i.test(normalizedUrl);

  let lastError: Error | null = null;

  for (const makeProxy of proxyGenerators) {
    try {
      const target = makeProxy(normalizedUrl);
      const resp = await fetch(target);
      if (!resp.ok) continue;

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();

      if (contentType.startsWith('image/') || isLikelyImageUrl) {
        const blob = await resp.blob();
        if (blob.size > 100 && (blob.type.startsWith('image/') || isLikelyImageUrl)) {
          const dataUrl = await blobToDataUrl(blob);
          return { primaryDataUrl: dataUrl, candidates: [] };
        }
      }

      const html = await resp.text();
      if (html && (html.includes('<img') || html.includes('og:image'))) {
        const candidates = extractFloorplanImagesFromHtml(html, normalizedUrl);
        if (candidates.length > 0) {
          try {
            const firstDataUrl = await fetchImageUrlAsDataUrl(candidates[0].url);
            return { primaryDataUrl: firstDataUrl, candidates };
          } catch {
            return { candidates };
          }
        }
      }
    } catch (e: any) {
      lastError = e;
    }
  }

  throw new Error(
    lastError?.message ||
      'Could not load floorplan from this URL. Try copying the direct image link or pasting/uploading the screenshot directly.'
  );
}

export async function fetchImageUrlAsDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:image/')) return imageUrl;

  const proxies = [
    (u: string) => u,
    (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];

  for (const makeProxy of proxies) {
    try {
      const resp = await fetch(makeProxy(imageUrl));
      if (!resp.ok) continue;
      const blob = await resp.blob();
      if (blob.size > 100) {
        return await blobToDataUrl(blob);
      }
    } catch {
      // try next proxy
    }
  }

  throw new Error('Could not fetch remote image due to cross-origin restrictions.');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read image blob.'));
    reader.readAsDataURL(blob);
  });
}

function extractFloorplanImagesFromHtml(
  html: string,
  baseUrl: string
): { url: string; label: string }[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const scored: { url: string; label: string; score: number }[] = [];
  const seen = new Set<string>();

  const resolveUrl = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const cleaned = raw.trim();
    if (!cleaned || cleaned.startsWith('data:image/svg+xml')) return null;
    try {
      return new URL(cleaned, baseUrl).href;
    } catch {
      return null;
    }
  };

  const scoreCandidate = (url: string, contextText: string, baseScore = 10) => {
    if (seen.has(url)) return;
    if (/\b(logo|icon|avatar|sprite|badge|favicon|pixel|tracker)\b/i.test(url)) return;
    seen.add(url);

    let score = baseScore;
    const combined = `${url} ${contextText}`.toLowerCase();
    if (/floor[-_ ]?plan|blueprint|layout|2d[-_ ]?plan|unit[-_ ]?plan|site[-_ ]?plan/.test(combined)) {
      score += 50;
    }
    if (/dimension|bedroom|apartment|suite|studio|sq[-_ ]?ft|sqm/.test(combined)) {
      score += 20;
    }
    if (/\.(png|jpg|jpeg|webp)/i.test(url)) {
      score += 5;
    }

    const label =
      contextText.trim().slice(0, 60) ||
      url.split('/').pop()?.split('?')[0]?.slice(0, 50) ||
      'Extracted Image';
    scored.push({ url, label, score });
  };

  doc
    .querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')
    .forEach((meta) => {
      const resolved = resolveUrl(meta.getAttribute('content'));
      if (resolved) scoreCandidate(resolved, 'Page Featured Image (og:image)', 25);
    });

  doc.querySelectorAll('img').forEach((img) => {
    const src =
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('srcset')?.split(',')[0]?.trim().split(' ')[0];
    const resolved = resolveUrl(src);
    if (!resolved) return;
    const alt = `${img.getAttribute('alt') || ''} ${img.getAttribute('title') || ''} ${
      img.className || ''
    }`;
    scoreCandidate(resolved, alt, 15);
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ url, label }) => ({ url, label }));
}

/**
 * Proportionally rescales all coordinates in FloorplanState around (100, 100)
 * when the user calibrates a reference distance on the canvas.
 */
export function rescaleFloorplanState(
  state: FloorplanState,
  scaleFactor: number
): FloorplanState {
  if (!isFinite(scaleFactor) || scaleFactor <= 0.05 || scaleFactor > 20) return state;

  const scaleX = (x: number) => Math.round(ORIGIN_OFFSET_X + (x - ORIGIN_OFFSET_X) * scaleFactor);
  const scaleY = (y: number) => Math.round(ORIGIN_OFFSET_Y + (y - ORIGIN_OFFSET_Y) * scaleFactor);

  return {
    ...state,
    walls: state.walls.map((w) => ({
      ...w,
      start: { x: scaleX(w.start.x), y: scaleY(w.start.y) },
      end: { x: scaleX(w.end.x), y: scaleY(w.end.y) },
    })),
    doors: state.doors.map((d) => ({
      ...d,
      x: scaleX(d.x),
      y: scaleY(d.y),
      width: Math.min(120, Math.max(65, Math.round(d.width * scaleFactor))),
    })),
    windows: state.windows.map((win) => ({
      ...win,
      x: scaleX(win.x),
      y: scaleY(win.y),
      width: Math.min(240, Math.max(60, Math.round(win.width * scaleFactor))),
    })),
    measurements: state.measurements.map((m) => ({
      ...m,
      start: { x: scaleX(m.start.x), y: scaleY(m.start.y) },
      end: { x: scaleX(m.end.x), y: scaleY(m.end.y) },
    })),
    roomLabels: (state.roomLabels || []).map((r) => ({
      ...r,
      x: scaleX(r.x),
      y: scaleY(r.y),
    })),
    background: state.background
      ? {
          ...state.background,
          x: scaleX(state.background.x),
          y: scaleY(state.background.y),
          width: Math.round(state.background.width * scaleFactor),
          height: Math.round(state.background.height * scaleFactor),
        }
      : null,
  };
}

/**
 * Generates a realistic architectural floorplan raster image (with thick structural walls,
 * doorway gaps, thin door arcs, exterior windows, and printed room dimensions)
 * so users can test deterministic image parsing + OCR dimension auto-scaling in 1 click.
 */
export function createSampleBlueprintDataUrl(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 620;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle thin background grid (1px - stripped by morphological opening)
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Thick structural walls (12px exterior, 9px interior)
  ctx.fillStyle = '#0f172a';

  // Top exterior wall (x=60..740, total span = 680px = 9.07m at 1.333 cm/px)
  ctx.fillRect(60, 60, 160, 12);
  ctx.fillRect(320, 60, 220, 12);
  ctx.fillRect(640, 60, 100, 12);

  // Bottom exterior wall with entrance door gap [180..245]
  ctx.fillRect(60, 540, 120, 12);
  ctx.fillRect(245, 540, 495, 12);

  // Left exterior wall
  ctx.fillRect(60, 60, 12, 492);

  // Right exterior wall with window gap [220..330]
  ctx.fillRect(728, 60, 12, 160);
  ctx.fillRect(728, 330, 12, 222);

  // Interior vertical bedroom wall (x=450) with doorway gap [340..405]
  ctx.fillRect(450, 60, 9, 280);
  ctx.fillRect(450, 405, 9, 147);

  // Interior horizontal kitchen/bath divider (y=290, x=60..455) with doorway gap [260..320]
  ctx.fillRect(60, 290, 200, 9);
  ctx.fillRect(320, 290, 135, 9);

  // Thin window glass pane lines (2px) inside window gaps
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.strokeRect(220, 62, 100, 8);
  ctx.strokeRect(540, 62, 100, 8);
  ctx.strokeRect(730, 220, 8, 110);

  // Thin door swing arcs (1.5px)
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(180, 540, 65, -Math.PI / 2, 0);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(455, 340, 65, 0, Math.PI / 2);
  ctx.stroke();

  // Printed room names & dimension labels (read by Tesseract OCR and matched to enclosing room walls)
  ctx.fillStyle = '#334155';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('LIVING ROOM', 175, 410);
  ctx.fillText('5.2m x 3.4m', 180, 440);

  ctx.fillText('BEDROOM', 530, 185);
  ctx.fillText('3.7m x 6.4m', 525, 215);

  ctx.fillText('KITCHEN', 190, 165);
  ctx.fillText('5.2m x 3.1m', 185, 195);

  return canvas.toDataURL('image/png');
}
