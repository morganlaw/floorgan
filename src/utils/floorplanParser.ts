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
  /** 0 = Auto threshold, 1..250 = manual darkness threshold */
  threshold: number;
  /** Minimum wall thickness in processing pixels (filters thin text, toilets, sinks, counters) */
  minWallThicknessPx: number;
  /** Minimum wall segment length in cm */
  minWallLengthCm: number;
  /** Target real-world width of the floorplan bounding box in meters */
  targetWidthMeters: number;
  /** Fill double-line hollow walls before erosion (only for unpainted CAD double-line plans) */
  closeHollowWalls: boolean;
  /** Detect doors and windows in collinear wall gaps */
  detectOpenings: boolean;
  /** Invert image brightness (for light-on-dark CAD blueprints) */
  invert: boolean;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  threshold: 0,
  minWallThicknessPx: 1,
  minWallLengthCm: 30,
  targetWidthMeters: 25,
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

export interface OcrTextBoxPx {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
const MAX_PROC_DIM = 750;

/**
 * Computes optimal binarization threshold (0..255) on a grayscale array.
 * Avoids thresholding light-gray bathroom floor tiles when solid black/dark-gray walls exist.
 */
function computeOtsuThreshold(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  const total = gray.length;
  let veryDarkCount = 0;
  for (let i = 0; i < total; i++) {
    const v = gray[i];
    hist[v]++;
    if (v < 70) veryDarkCount++;
  }

  // If the floorplan has clear dark ink (<70 luminance makes up at least 1.5% of pixels),
  // cap the threshold at 135 so light-gray floor tiles (170..235) are ignored.
  const hasStrongBlackWalls = veryDarkCount > total * 0.015;

  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let bestThreshold = 130;

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

  const maxAllowed = hasStrongBlackWalls ? 135 : 205;
  return Math.min(Math.max(bestThreshold, 65), maxAllowed);
}

/**
 * Connected-Component Filter (8-connected BFS):
 * Removes all isolated small islands from the binary mask BEFORE wall detection:
 * - Individual letters & words ("KITCHEN", "STUDY", "BATH", "9'3\" x 7'10\"", "REF", "DW", "W/D")
 * - Standalone icons (compass rose, entry arrows, stove burner rings)
 * - Detached small fixtures
 */
function filterConnectedComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  minSpanPx: number
): Uint8Array {
  const out = new Uint8Array(mask);
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const componentPixels: number[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const startIdx = y * w + x;
      if (!out[startIdx] || visited[startIdx]) continue;

      visited[startIdx] = 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = startIdx;
      componentPixels.length = 0;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (head < tail) {
        const curr = queue[head++];
        componentPixels.push(curr);
        const cy = Math.floor(curr / w);
        const cx = curr - cy * w;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          const nRow = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const nIdx = nRow + nx;
            if (out[nIdx] && !visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }
      }

      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;
      const maxSpan = Math.max(bboxW, bboxH);
      const minSpan = Math.max(1, Math.min(bboxW, bboxH));
      const area = componentPixels.length;
      const bboxArea = bboxW * bboxH;
      const fillRatio = area / bboxArea;
      const aspectRatio = maxSpan / minSpan;

      // Check if component contains at least one 4x4 solid structural wall core
      let hasSolidCore = false;
      if (maxSpan >= minSpanPx && minSpan >= 4) {
        for (let i = 0; i < componentPixels.length; i += 2) {
          const idx = componentPixels[i];
          const cy = Math.floor(idx / w);
          const cx = idx - cy * w;
          if (cx + 3 >= w || cy + 3 >= h) continue;
          let solid = true;
          for (let dy = 0; dy <= 3 && solid; dy++) {
            const r = (cy + dy) * w + cx;
            if (!out[r] || !out[r + 1] || !out[r + 2] || !out[r + 3]) {
              solid = false;
            }
          }
          if (solid) {
            hasSolidCore = true;
            break;
          }
        }
      }

      // 1. Any component smaller than minSpanPx (all letters, digits, stove rings, entry arrows) -> erase
      // 2. Any compact thin-line hollow blob (like a compass rose or standalone toilet/sink)
      //    that lacks a solid structural wall core -> erase
      // 3. Screenshot UI pill/bar touching the extreme top/bottom image border -> erase
      const isSmallIsland = maxSpan < minSpanPx || area < minSpanPx * 2.5;
      const isCompactIconOrText =
        !hasSolidCore &&
        maxSpan < Math.min(w, h) * 0.16 &&
        aspectRatio < 3.2 &&
        fillRatio < 0.48;
      const isEdgeBanner =
        (minY <= 1 || maxY >= h - 2) &&
        bboxH <= Math.round(h * 0.05) &&
        fillRatio > 0.62;

      if (isSmallIsland || isCompactIconOrText || isEdgeBanner) {
        for (let i = 0; i < componentPixels.length; i++) {
          out[componentPixels[i]] = 0;
        }
      }
    }
  }

  return out;
}

/**
 * Estimates the dominant thickness (in pixels) of structural walls vs. thin fixture outlines.
 */
function estimateStructuralWallThickness(mask: Uint8Array, w: number, h: number): number {
  const runHist = new Int32Array(32);

  // Sample horizontal and vertical run lengths
  for (let y = 0; y < h; y += 2) {
    const row = y * w;
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        run++;
      } else if (run > 0) {
        if (run >= 3 && run < 28) runHist[run]++;
        run = 0;
      }
    }
  }

  for (let x = 0; x < w; x += 2) {
    let run = 0;
    for (let y = 0; y < h; y++) {
      if (mask[y * w + x]) {
        run++;
      } else if (run > 0) {
        if (run >= 3 && run < 28) runHist[run]++;
        run = 0;
      }
    }
  }

  // Find the peak run thickness in the structural wall range [4..22]
  // weighting thicker runs slightly so 1-2px fixture lines don't dominate
  let bestT = 5;
  let bestScore = 0;
  for (let t = 4; t <= 20; t++) {
    const count = (runHist[t - 1] + runHist[t] * 2 + runHist[t + 1]) * Math.sqrt(t);
    if (count > bestScore) {
      bestScore = count;
      bestT = t;
    }
  }

  return bestT;
}

/**
 * 1D horizontal + vertical morphological closing to fill narrow hollow gaps inside double-line CAD walls,
 * while ignoring periodic multi-line comb patterns (closet shelf stripes, staircase treads, floor tile grids).
 */
function closeDoubleLineGaps(
  mask: Uint8Array,
  w: number,
  h: number,
  maxGap: number
): Uint8Array {
  const out = new Uint8Array(mask);

  for (let y = 2; y < h - 2; y++) {
    const rowOffset = y * w;
    let lastOn = -1;
    for (let x = 2; x < w - 2; x++) {
      if (mask[rowOffset + x]) {
        const gap = x - lastOn - 1;
        if (lastOn >= 2 && gap >= 1 && gap <= maxGap) {
          // Verify outer neighborhood has no parallel 3rd line (window bands, shelves, stairs)
          let outerRuns = 0;
          let inRun = false;
          for (let ox = Math.max(0, lastOn - 10); ox <= lastOn - 2; ox++) {
            const on = mask[rowOffset + ox] === 1;
            if (on && !inRun) {
              outerRuns++;
              inRun = true;
            } else if (!on) {
              inRun = false;
            }
          }
          inRun = false;
          for (let ox = x + 2; ox <= Math.min(w - 1, x + 10); ox++) {
            const on = mask[rowOffset + ox] === 1;
            if (on && !inRun) {
              outerRuns++;
              inRun = true;
            } else if (!on) {
              inRun = false;
            }
          }

          if (outerRuns === 0) {
            let parallelSupport = 0;
            for (let dy = -2; dy <= 2; dy++) {
              const r = (y + dy) * w;
              const leftOk = mask[r + lastOn] || mask[r + lastOn - 1];
              const rightOk = mask[r + x] || mask[r + x + 1];
              if (leftOk && rightOk) parallelSupport++;
            }
            if (parallelSupport >= 3) {
              for (let fillX = lastOn + 1; fillX < x; fillX++) {
                out[rowOffset + fillX] = 1;
              }
            }
          }
        }
        lastOn = x;
      }
    }
  }

  const finalOut = new Uint8Array(out);
  for (let x = 2; x < w - 2; x++) {
    let lastOn = -1;
    for (let y = 2; y < h - 2; y++) {
      if (out[y * w + x]) {
        const gap = y - lastOn - 1;
        if (lastOn >= 2 && gap >= 1 && gap <= maxGap) {
          let outerRuns = 0;
          let inRun = false;
          for (let oy = Math.max(0, lastOn - 10); oy <= lastOn - 2; oy++) {
            const on = out[oy * w + x] === 1;
            if (on && !inRun) {
              outerRuns++;
              inRun = true;
            } else if (!on) {
              inRun = false;
            }
          }
          inRun = false;
          for (let oy = y + 2; oy <= Math.min(h - 1, y + 10); oy++) {
            const on = out[oy * w + x] === 1;
            if (on && !inRun) {
              outerRuns++;
              inRun = true;
            } else if (!on) {
              inRun = false;
            }
          }

          if (outerRuns === 0) {
            let parallelSupport = 0;
            for (let dx = -2; dx <= 2; dx++) {
              const leftOk = out[lastOn * w + x + dx] || out[(lastOn - 1) * w + x + dx];
              const rightOk = out[y * w + x + dx] || out[(y + 1) * w + x + dx];
              if (leftOk && rightOk) parallelSupport++;
            }
            if (parallelSupport >= 3) {
              for (let fillY = lastOn + 1; fillY < y; fillY++) {
                finalOut[fillY * w + x] = 1;
              }
            }
          }
        }
        lastOn = y;
      }
    }
  }

  return finalOut;
}

/**
 * Exact kernelSize x kernelSize box erosion followed by box dilation (morphological opening).
 * Any stroke thinner than kernelSize (such as 1-3px toilet bowls, sinks, bathtubs, kitchen counters,
 * door swing arcs, or text letters) is completely erased.
 */
function morphologicalOpen(
  mask: Uint8Array,
  w: number,
  h: number,
  kernelSize: number
): Uint8Array {
  if (kernelSize <= 1) return new Uint8Array(mask);
  const kLeft = Math.floor((kernelSize - 1) / 2);
  const kRight = kernelSize - 1 - kLeft;

  // Erode horizontally by exact kernelSize
  const temp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = kLeft; x < w - kRight; x++) {
      let allOn = 1;
      for (let dx = -kLeft; dx <= kRight; dx++) {
        if (!mask[row + x + dx]) {
          allOn = 0;
          break;
        }
      }
      temp[row + x] = allOn;
    }
  }

  // Erode vertically by exact kernelSize
  const eroded = new Uint8Array(w * h);
  for (let y = kLeft; y < h - kRight; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let allOn = 1;
      for (let dy = -kLeft; dy <= kRight; dy++) {
        if (!temp[(y + dy) * w + x]) {
          allOn = 0;
          break;
        }
      }
      eroded[row + x] = allOn;
    }
  }

  // Dilate horizontally back by exact kernelSize
  const tempDilate = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = kRight; x < w - kLeft; x++) {
      let anyOn = 0;
      for (let dx = -kRight; dx <= kLeft; dx++) {
        if (eroded[row + x + dx]) {
          anyOn = 1;
          break;
        }
      }
      tempDilate[row + x] = anyOn;
    }
  }

  // Dilate vertically back by exact kernelSize
  const opened = new Uint8Array(w * h);
  for (let y = kRight; y < h - kLeft; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let anyOn = 0;
      for (let dy = -kRight; dy <= kLeft; dy++) {
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
 * Extracts sub-pixel / anti-aliased 1px fine detail ridges (for window symbols & door arcs that
 * fall above Otsu threshold due to downscaling) and directly extracts multi-line window bands.
 * Encodes detailMask bitflags: bit 0 (1) = rawMask, bit 1 (2) = hRidge, bit 2 (4) = vRidge.
 */
function extractFineDetailAndWindowBands(
  gray: Uint8Array,
  rawMask: Uint8Array,
  structuralMask: Uint8Array,
  w: number,
  h: number,
  ocrTextBoxes: OcrTextBoxPx[] = []
): { detailMask: Uint8Array; winBandsPx: RawSegment[] } {
  const hRidge = new Uint8Array(w * h);
  const vRidge = new Uint8Array(w * h);

  for (let y = 4; y < h - 4; y++) {
    const row = y * w;
    for (let x = 4; x < w - 4; x++) {
      const idx = row + x;
      const g = gray[idx];
      if (g > 236) continue;

      const gUp = gray[(y - 1) * w + x];
      const gDn = gray[(y + 1) * w + x];
      if (g <= gUp && g <= gDn && (g < gUp || g < gDn)) {
        let topMax = 0;
        let botMax = 0;
        for (let dy = 1; dy <= 5; dy++) {
          const vTop = gray[(y - dy) * w + x];
          const vBot = gray[(y + dy) * w + x];
          if (vTop > topMax) topMax = vTop;
          if (vBot > botMax) botMax = vBot;
        }
        if (topMax - g >= 10 && botMax - g >= 10 && Math.max(topMax, botMax) - g >= 15) {
          hRidge[idx] = 1;
        }
      }

      const gLt = gray[row + x - 1];
      const gRt = gray[row + x + 1];
      if (g <= gLt && g <= gRt && (g < gLt || g < gRt)) {
        let leftMax = 0;
        let rightMax = 0;
        for (let dx = 1; dx <= 5; dx++) {
          const vLt = gray[row + x - dx];
          const vRt = gray[row + x + dx];
          if (vLt > leftMax) leftMax = vLt;
          if (vRt > rightMax) rightMax = vRt;
        }
        if (leftMax - g >= 10 && rightMax - g >= 10 && Math.max(leftMax, rightMax) - g >= 15) {
          vRidge[idx] = 1;
        }
      }
    }
  }

  for (const box of ocrTextBoxes) {
    const x0 = Math.max(0, box.x0 - 1);
    const y0 = Math.max(0, box.y0 - 1);
    const x1 = Math.min(w - 1, box.x1 + 1);
    const y1 = Math.min(h - 1, box.y1 + 1);
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const idx = row + x;
        if (!structuralMask[idx]) {
          hRidge[idx] = 0;
          vRidge[idx] = 0;
        }
      }
    }
  }

  const detailMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    detailMask[i] = (rawMask[i] ? 1 : 0) | (hRidge[i] ? 2 : 0) | (vRidge[i] ? 4 : 0);
  }

  interface WinCrossRun {
    p0: number;
    p1: number;
    pc: number;
    thick: number;
  }

  interface WinChain {
    start: number;
    end: number;
    p0Sum: number;
    p1Sum: number;
    tSum: number;
    count: number;
    gaps: number;
  }

  // Extract horizontal multi-line window bands (2..5 parallel thin hRidge strokes within 3..16px)
  const hColRuns: WinCrossRun[][] = Array.from({ length: w }, () => []);
  for (let x = 2; x < w - 2; x++) {
    let y = 2;
    while (y < h - 2) {
      if (!hRidge[y * w + x] || structuralMask[y * w + x]) {
        y++;
        continue;
      }
      const yStart = y;
      let yLast = y;
      let strokeCount = 0;
      let hitSolid = false;
      let currY = y;
      while (currY < h - 2 && currY - yLast <= 6 && currY - yStart <= 18) {
        if (structuralMask[currY * w + x]) {
          hitSolid = true;
          break;
        }
        if (hRidge[currY * w + x]) {
          strokeCount++;
          yLast = currY;
          while (currY + 1 < h - 2 && hRidge[(currY + 1) * w + x]) currY++;
        }
        currY++;
      }
      const bandThick = yLast - yStart + 1;
      if (!hitSolid && strokeCount >= 2 && strokeCount <= 5 && bandThick >= 3 && bandThick <= 16) {
        let outerStrokes = 0;
        for (let dy = 5; dy <= 14; dy++) {
          if (yStart - dy >= 0 && hRidge[(yStart - dy) * w + x]) outerStrokes++;
          if (yLast + dy < h && hRidge[(yLast + dy) * w + x]) outerStrokes++;
        }
        let bgSide1 = 255;
        let bgSide2 = 255;
        if (yStart - 4 >= 0) {
          bgSide1 = 0;
          for (let dy = 4; dy <= 8; dy++) {
            if (yStart - dy >= 0 && gray[(yStart - dy) * w + x] > bgSide1) {
              bgSide1 = gray[(yStart - dy) * w + x];
            }
          }
        }
        if (yLast + 4 < h) {
          bgSide2 = 0;
          for (let dy = 4; dy <= 8; dy++) {
            if (yLast + dy < h && gray[(yLast + dy) * w + x] > bgSide2) {
              bgSide2 = gray[(yLast + dy) * w + x];
            }
          }
        }
        if (outerStrokes <= 2 && bgSide1 >= 205 && bgSide2 >= 205) {
          hColRuns[x].push({
            p0: yStart,
            p1: yLast,
            pc: (yStart + yLast) / 2,
            thick: bandThick,
          });
        }
      }
      y = Math.max(y + 1, yLast + 1);
    }
  }

  let activeHWin: WinChain[] = [];
  const finishedHWin: WinChain[] = [];
  for (let x = 0; x < w; x++) {
    const runs = hColRuns[x];
    const used = new Set<number>();
    const next: WinChain[] = [];
    for (const c of activeHWin) {
      const avgPc = (c.p0Sum + c.p1Sum) / (2 * c.count);
      let best = -1;
      let bestD = 2.5;
      for (let i = 0; i < runs.length; i++) {
        if (used.has(i)) continue;
        const d = Math.abs(runs[i].pc - avgPc);
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best !== -1) {
        used.add(best);
        const r = runs[best];
        c.end = x;
        c.p0Sum += r.p0;
        c.p1Sum += r.p1;
        c.tSum += r.thick;
        c.count++;
        c.gaps = 0;
        next.push(c);
      } else if (c.gaps < 3) {
        c.gaps++;
        next.push(c);
      } else {
        finishedHWin.push(c);
      }
    }
    for (let i = 0; i < runs.length; i++) {
      if (!used.has(i)) {
        const r = runs[i];
        next.push({
          start: x,
          end: x,
          p0Sum: r.p0,
          p1Sum: r.p1,
          tSum: r.thick,
          count: 1,
          gaps: 0,
        });
      }
    }
    activeHWin = next;
  }
  finishedHWin.push(...activeHWin);

  // Extract vertical multi-line window bands (2..5 parallel thin vRidge strokes within 3..16px)
  const vRowRuns: WinCrossRun[][] = Array.from({ length: h }, () => []);
  for (let y = 2; y < h - 2; y++) {
    const row = y * w;
    let x = 2;
    while (x < w - 2) {
      if (!vRidge[row + x] || structuralMask[row + x]) {
        x++;
        continue;
      }
      const xStart = x;
      let xLast = x;
      let strokeCount = 0;
      let hitSolid = false;
      let currX = x;
      while (currX < w - 2 && currX - xLast <= 6 && currX - xStart <= 18) {
        if (structuralMask[row + currX]) {
          hitSolid = true;
          break;
        }
        if (vRidge[row + currX]) {
          strokeCount++;
          xLast = currX;
          while (currX + 1 < w - 2 && vRidge[row + currX + 1]) currX++;
        }
        currX++;
      }
      const bandThick = xLast - xStart + 1;
      if (!hitSolid && strokeCount >= 2 && strokeCount <= 5 && bandThick >= 3 && bandThick <= 16) {
        let outerStrokes = 0;
        for (let dx = 5; dx <= 14; dx++) {
          if (xStart - dx >= 0 && vRidge[row + xStart - dx]) outerStrokes++;
          if (xLast + dx < w && vRidge[row + xLast + dx]) outerStrokes++;
        }
        let bgSide1 = 255;
        let bgSide2 = 255;
        if (xStart - 4 >= 0) {
          bgSide1 = 0;
          for (let dx = 4; dx <= 8; dx++) {
            if (xStart - dx >= 0 && gray[row + xStart - dx] > bgSide1) {
              bgSide1 = gray[row + xStart - dx];
            }
          }
        }
        if (xLast + 4 < w) {
          bgSide2 = 0;
          for (let dx = 4; dx <= 8; dx++) {
            if (xLast + dx < w && gray[row + xLast + dx] > bgSide2) {
              bgSide2 = gray[row + xLast + dx];
            }
          }
        }
        if (outerStrokes <= 2 && bgSide1 >= 205 && bgSide2 >= 205) {
          vRowRuns[y].push({
            p0: xStart,
            p1: xLast,
            pc: (xStart + xLast) / 2,
            thick: bandThick,
          });
        }
      }
      x = Math.max(x + 1, xLast + 1);
    }
  }

  let activeVWin: WinChain[] = [];
  const finishedVWin: WinChain[] = [];
  for (let y = 0; y < h; y++) {
    const runs = vRowRuns[y];
    const used = new Set<number>();
    const next: WinChain[] = [];
    for (const c of activeVWin) {
      const avgPc = (c.p0Sum + c.p1Sum) / (2 * c.count);
      let best = -1;
      let bestD = 2.5;
      for (let i = 0; i < runs.length; i++) {
        if (used.has(i)) continue;
        const d = Math.abs(runs[i].pc - avgPc);
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best !== -1) {
        used.add(best);
        const r = runs[best];
        c.end = y;
        c.p0Sum += r.p0;
        c.p1Sum += r.p1;
        c.tSum += r.thick;
        c.count++;
        c.gaps = 0;
        next.push(c);
      } else if (c.gaps < 3) {
        c.gaps++;
        next.push(c);
      } else {
        finishedVWin.push(c);
      }
    }
    for (let i = 0; i < runs.length; i++) {
      if (!used.has(i)) {
        const r = runs[i];
        next.push({
          start: y,
          end: y,
          p0Sum: r.p0,
          p1Sum: r.p1,
          tSum: r.thick,
          count: 1,
          gaps: 0,
        });
      }
    }
    activeVWin = next;
  }
  finishedVWin.push(...activeVWin);

  const rawWinBandsPx: RawSegment[] = [
    ...finishedHWin
      .filter((c) => c.end - c.start >= 22 && c.count >= 16)
      .map((c) => ({
        axis: 'h' as const,
        pos: Math.round(((c.p0Sum + c.p1Sum) / (2 * c.count)) * 2) / 2,
        start: c.start,
        end: c.end,
        thickness: Math.max(4, Math.round(c.tSum / c.count)),
      })),
    ...finishedVWin
      .filter((c) => c.end - c.start >= 22 && c.count >= 16)
      .map((c) => ({
        axis: 'v' as const,
        pos: Math.round(((c.p0Sum + c.p1Sum) / (2 * c.count)) * 2) / 2,
        start: c.start,
        end: c.end,
        thickness: Math.max(4, Math.round(c.tSum / c.count)),
      })),
  ];

  // Suppress duplicate inner/outer parallel window bands across deep facade piers (within 28px with >=65% overlap),
  // keeping the outer band closer to the building perimeter.
  const winBandsPx = rawWinBandsPx.filter((wb, idx) => {
    const wbLen = wb.end - wb.start;
    const midCanvas = wb.axis === 'h' ? h * 0.5 : w * 0.5;
    const wbDistToEdge = wb.pos < midCanvas ? wb.pos : (wb.axis === 'h' ? h - wb.pos : w - wb.pos);
    for (let j = 0; j < rawWinBandsPx.length; j++) {
      if (idx === j) continue;
      const other = rawWinBandsPx[j];
      if (other.axis !== wb.axis) continue;
      if (Math.abs(wb.pos - other.pos) > 28) continue;
      const overlap = Math.min(wb.end, other.end) - Math.max(wb.start, other.start);
      const minLen = Math.min(wbLen, other.end - other.start);
      if (overlap >= minLen * 0.65) {
        const otherDistToEdge =
          other.pos < midCanvas ? other.pos : (other.axis === 'h' ? h - other.pos : w - other.pos);
        if (otherDistToEdge < wbDistToEdge || (otherDistToEdge === wbDistToEdge && j < idx)) {
          return false;
        }
      }
    }
    return true;
  });

  return { detailMask, winBandsPx };
}

/**
 * Extracts directional wall bands (horizontal & vertical) from the cleaned binary wall mask.
 */
function extractDirectionalWallSegments(
  wallMask: Uint8Array,
  w: number,
  h: number,
  minLengthPx: number,
  minThicknessPx: number,
  dominantWallThickPx = 6
): RawSegment[] {
  const maxWallThicknessPx = Math.min(26, Math.max(16, Math.round(dominantWallThickPx * 2.6)));

  interface ColRun {
    y0: number;
    y1: number;
    yc: number;
    thick: number;
  }

  interface RowRun {
    x0: number;
    x1: number;
    xc: number;
    thick: number;
  }

  interface HChain {
    start: number;
    end: number;
    firstNormalStart: number;
    lastNormalEnd: number;
    y0Sum: number;
    y1Sum: number;
    tSum: number;
    validCols: number;
    junctionGap: number;
  }

  interface VChain {
    start: number;
    end: number;
    firstNormalStart: number;
    lastNormalEnd: number;
    x0Sum: number;
    x1Sum: number;
    tSum: number;
    validRows: number;
    junctionGap: number;
  }

  // 1. Extract Horizontal Segments by chaining vertical column runs [y0, y1] across x = 0..w-1
  const colRuns: ColRun[][] = Array.from({ length: w }, () => []);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!wallMask[y * w + x]) {
        y++;
        continue;
      }
      let yEnd = y;
      while (yEnd < h && wallMask[yEnd * w + x]) yEnd++;
      const thick = yEnd - y;
      if (thick >= minThicknessPx) {
        colRuns[x].push({ y0: y, y1: yEnd - 1, yc: (y + yEnd - 1) / 2, thick });
      }
      y = yEnd;
    }
  }

  let activeH: HChain[] = [];
  const finishedH: HChain[] = [];

  for (let x = 0; x < w; x++) {
    const runs = colRuns[x];
    const usedRuns = new Set<number>();
    const nextActive: HChain[] = [];

    for (const chain of activeH) {
      const avgY0 = chain.y0Sum / chain.validCols;
      const avgY1 = chain.y1Sum / chain.validCols;
      const avgYc = (avgY0 + avgY1) / 2;
      const avgT = chain.tSum / chain.validCols;

      let bestIdx = -1;
      let bestMode: 'normal' | 'flush_thick' = 'normal';
      let bestDist = 2.4;
      for (let i = 0; i < runs.length; i++) {
        if (usedRuns.has(i)) continue;
        const r = runs[i];
        if (r.thick <= maxWallThicknessPx) {
          const d = Math.abs(r.yc - avgYc);
          if (d <= bestDist && Math.abs(r.thick - avgT) <= 3.5) {
            bestDist = d;
            bestIdx = i;
            bestMode = 'normal';
          } else if (
            bestIdx === -1 &&
            chain.validCols >= 5 &&
            r.thick > Math.max(avgT + 3, 12) &&
            (Math.abs(r.y0 - avgY0) <= 2.0 || Math.abs(r.y1 - avgY1) <= 2.0)
          ) {
            bestIdx = i;
            bestMode = 'flush_thick';
          }
        }
      }

      if (bestIdx !== -1) {
        const r = runs[bestIdx];
        chain.end = x;
        if (bestMode === 'normal') {
          usedRuns.add(bestIdx);
          chain.lastNormalEnd = x;
          chain.y0Sum += r.y0;
          chain.y1Sum += r.y1;
          chain.tSum += r.thick;
          chain.validCols++;
        }
        chain.junctionGap = 0;
        nextActive.push(chain);
        continue;
      }

      // Check if column x is a vertical wall junction or Poché pier that covers avgYc
      let throughJunction = false;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (r.thick > maxWallThicknessPx && r.y0 <= avgYc + 2 && r.y1 >= avgYc - 2) {
          throughJunction = true;
          break;
        }
      }

      if (throughJunction && chain.junctionGap < maxWallThicknessPx * 2.2) {
        chain.end = x;
        chain.junctionGap++;
        nextActive.push(chain);
      } else {
        finishedH.push(chain);
      }
    }

    for (let i = 0; i < runs.length; i++) {
      if (usedRuns.has(i)) continue;
      const r = runs[i];
      if (r.thick >= minThicknessPx && r.thick <= maxWallThicknessPx) {
        nextActive.push({
          start: x,
          end: x,
          firstNormalStart: x,
          lastNormalEnd: x,
          y0Sum: r.y0,
          y1Sum: r.y1,
          tSum: r.thick,
          validCols: 1,
          junctionGap: 0,
        });
      }
    }

    activeH = nextActive;
  }
  finishedH.push(...activeH);

  for (const c of finishedH) {
    const avgY0 = c.y0Sum / c.validCols;
    const avgY1 = c.y1Sum / c.validCols;
    const avgYc = (avgY0 + avgY1) / 2;
    const avgT = c.tSum / c.validCols;
    const halfT = Math.max(4, Math.min(7, Math.round(avgT * 0.55)));

    // If the chain ended inside a perpendicular junction or corner step without resuming normal runs,
    // trim c.end to the centerline of that corner/junction unless it ran through a wide corner pier
    if (c.end > c.lastNormalEnd && c.end - c.lastNormalEnd <= maxWallThicknessPx) {
      c.end = c.lastNormalEnd + Math.min(halfT, c.end - c.lastNormalEnd);
    }

    // Extend c.start backward into an abutting perpendicular wall or corner step block
    let backGap = 0;
    let touchedPerpWall = false;
    let touchedStepBlock = false;
    while (c.start > 0 && backGap < maxWallThicknessPx * 2) {
      const prevRuns = colRuns[c.start - 1];
      const hitsStep = prevRuns.some(
        (r) =>
          r.thick <= maxWallThicknessPx * 1.4 &&
          r.thick > avgT + 3 &&
          r.y0 <= avgYc + 2 &&
          r.y1 >= avgYc - 2 &&
          (Math.abs(r.y0 - avgY0) <= 2.2 || Math.abs(r.y1 - avgY1) <= 2.2)
      );
      const hitsPerp =
        !hitsStep &&
        prevRuns.some(
          (r) => r.thick > maxWallThicknessPx && r.y0 <= avgYc + 2 && r.y1 >= avgYc - 2
        );
      if (hitsPerp) {
        touchedPerpWall = true;
        c.start--;
        backGap++;
      } else if (hitsStep && !touchedPerpWall) {
        touchedStepBlock = true;
        c.start--;
        backGap++;
      } else {
        break;
      }
    }
    if (
      touchedPerpWall &&
      c.firstNormalStart - c.start > halfT &&
      c.firstNormalStart - c.start <= maxWallThicknessPx
    ) {
      c.start = c.firstNormalStart - halfT;
    } else if (touchedStepBlock && c.firstNormalStart - c.start > halfT) {
      c.start += Math.min(halfT, c.firstNormalStart - c.start);
    }
  }

  // 2. Extract Vertical Segments by chaining horizontal row runs [x0, x1] across y = 0..h-1
  const rowRuns: RowRun[][] = Array.from({ length: h }, () => []);
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
      const thick = xEnd - x;
      if (thick >= minThicknessPx) {
        rowRuns[y].push({ x0: x, x1: xEnd - 1, xc: (x + xEnd - 1) / 2, thick });
      }
      x = xEnd;
    }
  }

  let activeV: VChain[] = [];
  const finishedV: VChain[] = [];

  for (let y = 0; y < h; y++) {
    const runs = rowRuns[y];
    const usedRuns = new Set<number>();
    const nextActive: VChain[] = [];

    for (const chain of activeV) {
      const avgX0 = chain.x0Sum / chain.validRows;
      const avgX1 = chain.x1Sum / chain.validRows;
      const avgXc = (avgX0 + avgX1) / 2;
      const avgT = chain.tSum / chain.validRows;

      let bestIdx = -1;
      let bestMode: 'normal' | 'flush_thick' = 'normal';
      let bestDist = 2.4;
      for (let i = 0; i < runs.length; i++) {
        if (usedRuns.has(i)) continue;
        const r = runs[i];
        if (r.thick <= maxWallThicknessPx) {
          const d = Math.abs(r.xc - avgXc);
          if (d <= bestDist && Math.abs(r.thick - avgT) <= 3.5) {
            bestDist = d;
            bestIdx = i;
            bestMode = 'normal';
          } else if (
            bestIdx === -1 &&
            chain.validRows >= 5 &&
            r.thick > Math.max(avgT + 3, 12) &&
            (Math.abs(r.x0 - avgX0) <= 2.0 || Math.abs(r.x1 - avgX1) <= 2.0)
          ) {
            bestIdx = i;
            bestMode = 'flush_thick';
          }
        }
      }

      if (bestIdx !== -1) {
        const r = runs[bestIdx];
        chain.end = y;
        if (bestMode === 'normal') {
          usedRuns.add(bestIdx);
          chain.lastNormalEnd = y;
          chain.x0Sum += r.x0;
          chain.x1Sum += r.x1;
          chain.tSum += r.thick;
          chain.validRows++;
        }
        chain.junctionGap = 0;
        nextActive.push(chain);
        continue;
      }

      let throughJunction = false;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (r.thick > maxWallThicknessPx && r.x0 <= avgXc + 2 && r.x1 >= avgXc - 2) {
          throughJunction = true;
          break;
        }
      }

      if (throughJunction && chain.junctionGap < maxWallThicknessPx * 2.2) {
        chain.end = y;
        chain.junctionGap++;
        nextActive.push(chain);
      } else {
        finishedV.push(chain);
      }
    }

    for (let i = 0; i < runs.length; i++) {
      if (usedRuns.has(i)) continue;
      const r = runs[i];
      if (r.thick >= minThicknessPx && r.thick <= maxWallThicknessPx) {
        nextActive.push({
          start: y,
          end: y,
          firstNormalStart: y,
          lastNormalEnd: y,
          x0Sum: r.x0,
          x1Sum: r.x1,
          tSum: r.thick,
          validRows: 1,
          junctionGap: 0,
        });
      }
    }

    activeV = nextActive;
  }
  finishedV.push(...activeV);

  for (const c of finishedV) {
    const avgX0 = c.x0Sum / c.validRows;
    const avgX1 = c.x1Sum / c.validRows;
    const avgXc = (avgX0 + avgX1) / 2;
    const avgT = c.tSum / c.validRows;
    const halfT = Math.max(4, Math.min(7, Math.round(avgT * 0.55)));

    if (c.end > c.lastNormalEnd && c.end - c.lastNormalEnd <= maxWallThicknessPx) {
      c.end = c.lastNormalEnd + Math.min(halfT, c.end - c.lastNormalEnd);
    }

    let backGap = 0;
    let touchedPerpWall = false;
    let touchedStepBlock = false;
    while (c.start > 0 && backGap < maxWallThicknessPx * 2) {
      const prevRuns = rowRuns[c.start - 1];
      const hitsPerp = prevRuns.some(
        (r) => r.thick > maxWallThicknessPx && r.x0 <= avgXc + 2 && r.x1 >= avgXc - 2
      );
      const hitsStep = prevRuns.some(
        (r) =>
          r.thick <= maxWallThicknessPx &&
          r.thick > avgT + 3 &&
          r.x0 <= avgXc + 2 &&
          r.x1 >= avgXc - 2 &&
          (Math.abs(r.x0 - avgX0) <= 2.2 || Math.abs(r.x1 - avgX1) <= 2.2)
      );
      if (hitsPerp) {
        touchedPerpWall = true;
        c.start--;
        backGap++;
      } else if (hitsStep && !touchedPerpWall) {
        touchedStepBlock = true;
        c.start--;
        backGap++;
      } else {
        break;
      }
    }
    if (
      touchedPerpWall &&
      c.firstNormalStart - c.start > halfT &&
      c.firstNormalStart - c.start <= maxWallThicknessPx
    ) {
      c.start = c.firstNormalStart - halfT;
    } else if (touchedStepBlock && c.firstNormalStart - c.start > 10) {
      c.start = c.firstNormalStart - Math.round((c.firstNormalStart - c.start) * 0.55);
    }
  }

  // Only suppress a parallel stub if its cross-axis wall thickness interval actually overlaps a longer wall
  const suppressParallelStubs = (segs: RawSegment[]): RawSegment[] =>
    segs.filter((seg, idx) => {
      const segLen = seg.end - seg.start;
      for (let j = 0; j < segs.length; j++) {
        if (idx === j) continue;
        const other = segs[j];
        const otherLen = other.end - other.start;
        if (otherLen <= segLen * 1.35) continue;
        const maxCrossDist = Math.max(8, (seg.thickness + other.thickness) * 0.6);
        if (Math.abs(seg.pos - other.pos) <= maxCrossDist) {
          const overlap = Math.min(seg.end, other.end) - Math.max(seg.start, other.start);
          if (overlap >= segLen * 0.65) {
            return false;
          }
        }
      }
      return true;
    });

  const hSegs: RawSegment[] = suppressParallelStubs(
    finishedH
      .filter((c) => {
        const len = c.end - c.start;
        const joinedCorner = c.start < c.firstNormalStart || c.end > c.lastNormalEnd;
        const minLen = joinedCorner ? 5 : minLengthPx;
        const minValid = joinedCorner ? 2 : Math.min(7, Math.round(minLengthPx * 0.5));
        return len >= minLen && c.validCols >= minValid;
      })
      .map((c) => {
        const y0 = c.y0Sum / c.validCols;
        const y1 = c.y1Sum / c.validCols;
        return {
          axis: 'h' as const,
          pos: Math.round((y0 + y1) * 0.5 * 2) / 2,
          start: c.start,
          end: c.end,
          thickness: Math.round(c.tSum / c.validCols),
        };
      })
  );

  const vSegs: RawSegment[] = suppressParallelStubs(
    finishedV
      .filter((c) => {
        const len = c.end - c.start;
        const joinedCorner = c.start < c.firstNormalStart || c.end > c.lastNormalEnd;
        const minLen = joinedCorner ? 5 : minLengthPx;
        const minValid = joinedCorner ? 2 : Math.min(7, Math.round(minLengthPx * 0.5));
        return len >= minLen && c.validRows >= minValid;
      })
      .map((c) => {
        const x0 = c.x0Sum / c.validRows;
        const x1 = c.x1Sum / c.validRows;
        return {
          axis: 'v' as const,
          pos: Math.round((x0 + x1) * 0.5 * 2) / 2,
          start: c.start,
          end: c.end,
          thickness: Math.round(c.tSum / c.validRows),
        };
      })
  );

  return [...hSegs, ...vSegs];
}

/**
 * Helper to decode an imperial feet/inches token where OCR may have dropped the apostrophe:
 * e.g. "9'3\"" -> 9ft 3in; "93\"" -> 9ft 3in; "710\"" -> 7ft 10in; "106\"" -> 10ft 6in; "9'" -> 9ft 0in.
 */
function parseImperialTokenToCm(
  rawDigits1: string,
  sep1: string | undefined,
  rawDigits2: string | undefined
): number | null {
  if (rawDigits2 !== undefined && rawDigits2 !== '') {
    // Explicit feet and inches: e.g. 13'8" or 9'3"
    const ft = parseInt(rawDigits1, 10);
    const inches = parseInt(rawDigits2, 10);
    if (ft >= 2 && ft <= 60 && inches >= 0 && inches < 12) {
      return Math.round((ft * 12 + inches) * 2.54);
    }
  }

  const n = parseInt(rawDigits1, 10);
  if (isNaN(n)) return null;

  // If 1 or 2 digits <= 45 with ' or ": e.g. "9'" or "12'"
  if (n >= 3 && n <= 45 && (sep1 === "'" || !sep1)) {
    return Math.round(n * 12 * 2.54);
  }

  // OCR dropped the apostrophe between feet and inches (e.g. "93\"", "58\"", "87\"", "710\"", "106\"")
  if (rawDigits1.length === 2 && n >= 30 && n <= 99) {
    const ft = parseInt(rawDigits1[0], 10);
    const inches = parseInt(rawDigits1[1], 10);
    return Math.round((ft * 12 + inches) * 2.54);
  }

  if (rawDigits1.length === 3) {
    const lastTwo = parseInt(rawDigits1.slice(1), 10);
    if (lastTwo === 10 || lastTwo === 11) {
      // e.g. "710\"" -> 7' 10"
      const ft = parseInt(rawDigits1[0], 10);
      return Math.round((ft * 12 + lastTwo) * 2.54);
    } else {
      // e.g. "106\"" -> 10' 6"
      const ft = parseInt(rawDigits1.slice(0, 2), 10);
      const inches = parseInt(rawDigits1[2], 10);
      if (ft >= 3 && ft <= 50 && inches <= 9) {
        return Math.round((ft * 12 + inches) * 2.54);
      }
    }
  }

  if (rawDigits1.length === 4) {
    const ft = parseInt(rawDigits1.slice(0, 2), 10);
    const inches = parseInt(rawDigits1.slice(2), 10);
    if (ft >= 3 && ft <= 50 && inches < 12) {
      return Math.round((ft * 12 + inches) * 2.54);
    }
  }

  return null;
}

function formatImperialCm(cm: number): string {
  const totalIn = Math.round(cm / 2.54);
  const ft = Math.floor(totalIn / 12);
  const inches = totalIn % 12;
  return inches > 0 ? `${ft}'${inches}"` : `${ft}'`;
}

/**
 * Parses architectural dimension strings from OCR text lines/words into centimeters.
 * Supports:
 * - Metric pairs: "5.2m x 3.8m", "5.20 x 3.80 m", "520 x 380 cm"
 * - Imperial pairs (even when OCR drops the ' apostrophe): "9'3\" x 7'10\"", "93\" x 710\"", "10'6\" x 9'"
 * - Single wall callouts: "5.2m", "420 cm", "14' 6\""
 */
export function parseDimensionText(
  text: string
): { kind: 'pair' | 'single'; unit: Unit; val1Cm: number; val2Cm?: number; matchedText: string } | null {
  const cleaned = text
    .replace(/[×✕＊*]/g, 'x')
    .replace(/[""״”‟]/g, '"')
    .replace(/[''′´`’‘°]/g, "'")
    .replace(/(\d)\s*[:;]\s*(\d)/g, "$1'$2")
    .replace(/''/g, '"')
    .trim();

  // 1. Imperial feet/inches pair (handles both "13'8\" x 10'5\"" and OCR-dropped-apostrophe "93\" x 710\"" or "106\" x 9'")
  const impFlexRegex =
    /(\d{1,4})\s*(['"])?\s*(?:-\s*)?(?:(\d{1,2})\s*"?)?\s*[xX]\s*(\d{1,4})\s*(['"])?\s*(?:-\s*)?(?:(\d{1,2})\s*"?)?/;
  const impFlexMatch = cleaned.match(impFlexRegex);
  if (
    impFlexMatch &&
    (cleaned.includes("'") || cleaned.includes('"')) &&
    !/\b(mm|cm|m)\b/i.test(cleaned)
  ) {
    const cm1 = parseImperialTokenToCm(impFlexMatch[1], impFlexMatch[2], impFlexMatch[3]);
    const cm2 = parseImperialTokenToCm(impFlexMatch[4], impFlexMatch[5], impFlexMatch[6]);
    if (cm1 && cm2 && cm1 >= 80 && cm1 <= 2500 && cm2 >= 80 && cm2 <= 2500) {
      return {
        kind: 'pair',
        unit: 'ft',
        val1Cm: cm1,
        val2Cm: cm2,
        matchedText: `${formatImperialCm(cm1)} x ${formatImperialCm(cm2)}`,
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
      // Handle OCR dropped decimal point in 3-digit meter dimensions like "434x426m" (4.34 x 4.26 m)
      cm1 = raw1 >= 100 && raw1 <= 999 && !/[.,]/.test(metricPairMatch[1]) ? raw1 : raw1 * 100;
      cm2 = raw2 >= 100 && raw2 <= 999 && !/[.,]/.test(metricPairMatch[3]) ? raw2 : raw2 * 100;
    } else {
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

  // 3. Single Imperial dimension callout: e.g. "14' 6\""
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
 * using 4-directional ray casting, partial wing-wall detection for open-plan rooms,
 * and consensus scale verification.
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
  cmPerPxX: number | null;
  cmPerPxY: number | null;
} {
  if (candidates.length === 0 || rawSegmentsPx.length === 0) {
    return {
      matched: [],
      calibratedWidthMeters: null,
      detectedUnit: null,
      cmPerPx: null,
      cmPerPxX: null,
      cmPerPxY: null,
    };
  }

  // Bridge collinear/stepped doorway gaps up to 62px wide so room rays never escape through open doorways
  const bridgeWallGapsForRays = (segs: RawSegment[]): RawSegment[] => {
    const out = [...segs];
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i];
      if (a.end - a.start < 12) continue;
      for (let j = 0; j < segs.length; j++) {
        if (i === j) continue;
        const b = segs[j];
        if (b.end - b.start < 12) continue;
        if (Math.abs(a.pos - b.pos) <= 8 && b.start > a.end && b.start - a.end <= 62) {
          out.push({
            axis: a.axis,
            pos: (a.pos + b.pos) / 2,
            start: a.start,
            end: b.end,
            thickness: (a.thickness + b.thickness) / 2,
          });
        }
      }
    }
    return out;
  };

  const hWalls = bridgeWallGapsForRays(rawSegmentsPx.filter((s) => s.axis === 'h'));
  const vWalls = bridgeWallGapsForRays(rawSegmentsPx.filter((s) => s.axis === 'v'));

  interface VerifiedRoomScale {
    scale: number;
    scaleX: number;
    scaleY: number;
    areaPx: number;
    diff: number;
  }

  const verifiedRooms: VerifiedRoomScale[] = [];
  const fallbackAxisScales: { idx: number; scales: number[]; spanPx?: { x1: number; y1: number; x2: number; y2: number } }[] = [];
  const prelimMatched: {
    cand: RawDimensionCandidate;
    matchedSpanPx?: { x1: number; y1: number; x2: number; y2: number };
    impliedCmPerPx?: number;
  }[] = [];

  for (let idx = 0; idx < candidates.length; idx++) {
    const cand = candidates[idx];
    const { cxPx, cyPx } = cand;

    if (cand.kind === 'pair' && cand.val2Cm) {
      let topWall: RawSegment | null = null;
      let bottomWall: RawSegment | null = null;

      // Tight cross margin (12px) so short corner notches don't intercept rays before the main room wall
      const crossMarginPx = 12;

      for (const hw of hWalls) {
        if (hw.end - hw.start < 16) continue;
        if (cxPx >= hw.start - crossMarginPx && cxPx <= hw.end + crossMarginPx) {
          if (hw.pos < cyPx && (!topWall || hw.pos > topWall.pos)) {
            topWall = hw;
          }
          if (hw.pos > cyPx && (!bottomWall || hw.pos < bottomWall.pos)) {
            bottomWall = hw;
          }
        }
      }

      const roomTop = topWall ? topWall.pos : cyPx - 60;
      const roomBottom = bottomWall ? bottomWall.pos : cyPx + 60;

      let leftWall: RawSegment | null = null;
      let rightWall: RawSegment | null = null;

      for (const vw of vWalls) {
        const crossesCy =
          vw.end - vw.start >= 16 &&
          cyPx >= vw.start - crossMarginPx &&
          cyPx <= vw.end + crossMarginPx;
        const overlapY = Math.min(vw.end, roomBottom) - Math.max(vw.start, roomTop);
        const isWingDivider =
          topWall !== null &&
          bottomWall !== null &&
          vw.end - vw.start >= 32 &&
          overlapY >= (roomBottom - roomTop) * 0.25;

        if (crossesCy || isWingDivider) {
          if (vw.pos < cxPx && (!leftWall || vw.pos > leftWall.pos)) {
            leftWall = vw;
          }
          if (vw.pos > cxPx && (!rightWall || vw.pos < rightWall.pos)) {
            rightWall = vw;
          }
        }
      }

      let leftX = leftWall ? leftWall.pos : null;
      let rightX = rightWall ? rightWall.pos : null;

      // If one side of the room is a full-height window, use the shared endpoint of topWall & bottomWall
      if (topWall && bottomWall) {
        if (rightX === null && Math.abs(topWall.end - bottomWall.end) < 20 && topWall.end > cxPx) {
          rightX = Math.round((topWall.end + bottomWall.end) / 2);
        }
        if (
          leftX === null &&
          Math.abs(topWall.start - bottomWall.start) < 20 &&
          topWall.start < cxPx
        ) {
          leftX = Math.round((topWall.start + bottomWall.start) / 2);
        }
      }

      const roomW = leftX !== null && rightX !== null ? rightX - leftX : 0;
      const roomH = topWall && bottomWall ? bottomWall.pos - topWall.pos : 0;

      if (roomW > 30 && roomH > 30) {
        const directRatioX = cand.val1Cm / roomW;
        const directRatioY = cand.val2Cm / roomH;
        const directDiff =
          Math.abs(directRatioX - directRatioY) / Math.max(directRatioX, directRatioY);

        const swappedRatioX = cand.val2Cm / roomW;
        const swappedRatioY = cand.val1Cm / roomH;
        const swappedDiff =
          Math.abs(swappedRatioX - swappedRatioY) / Math.max(swappedRatioX, swappedRatioY);

        const useSwapped = directDiff > 0.14 && swappedDiff < directDiff * 0.55;
        const bestDiff = useSwapped ? swappedDiff : directDiff;
        const scaleX = useSwapped ? swappedRatioX : directRatioX;
        const scaleY = useSwapped ? swappedRatioY : directRatioY;
        const avgScale = (scaleX + scaleY) / 2;

        const spanBox = {
          x1: leftX!,
          y1: topWall!.pos,
          x2: rightX!,
          y2: bottomWall!.pos,
        };

        if (bestDiff < 0.25 && avgScale >= 0.2 && avgScale <= 15) {
          verifiedRooms.push({
            scale: avgScale,
            scaleX,
            scaleY,
            areaPx: roomW * roomH,
            diff: bestDiff,
          });
          prelimMatched.push({
            cand,
            matchedSpanPx: spanBox,
            impliedCmPerPx: avgScale,
          });
          continue;
        } else {
          // Record individual axis scales for consensus verification against other rooms
          fallbackAxisScales.push({
            idx,
            scales: [directRatioX, directRatioY, swappedRatioX, swappedRatioY].filter(
              (s) => s >= 0.2 && s <= 15
            ),
            spanPx: spanBox,
          });
        }
      } else if (roomH > 30 || roomW > 30) {
        const possibleScales: number[] = [];
        if (roomW > 30) {
          possibleScales.push(cand.val1Cm / roomW, cand.val2Cm / roomW);
        }
        if (roomH > 30) {
          possibleScales.push(cand.val2Cm / roomH, cand.val1Cm / roomH);
        }
        fallbackAxisScales.push({
          idx,
          scales: possibleScales.filter((s) => s >= 0.2 && s <= 15),
        });
      }
    } else if (cand.kind === 'single') {
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
          verifiedRooms.push({
            scale,
            scaleX: scale,
            scaleY: scale,
            areaPx: lenPx * lenPx * 0.5,
            diff: 0.05,
          });
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
  let cmPerPxX: number | null = null;
  let cmPerPxY: number | null = null;

  if (verifiedRooms.length > 0) {
    // Anchor on the largest verified room and weight by (areaPx^2) / (0.005 + diff^2)
    // so large primary rooms with tight X/Y agreement dominate over small utility rooms
    const largestRoom = verifiedRooms.reduce((a, b) => (b.areaPx > a.areaPx ? b : a));
    const inliers = verifiedRooms.filter(
      (r) => Math.abs(r.scale - largestRoom.scale) / largestRoom.scale <= 0.18
    );
    const activeRooms = inliers.length > 0 ? inliers : verifiedRooms;

    let sumW = 0;
    let sumScale = 0;
    let sumScaleX = 0;
    let sumScaleY = 0;
    for (const r of activeRooms) {
      const w = (r.areaPx * r.areaPx) / (0.005 + r.diff * r.diff);
      sumW += w;
      sumScale += r.scale * w;
      sumScaleX += r.scaleX * w;
      sumScaleY += r.scaleY * w;
    }
    medianCmPerPx = sumScale / sumW;
    cmPerPxX = sumScaleX / sumW;
    cmPerPxY = sumScaleY / sumW;

    if (Math.abs(cmPerPxX - cmPerPxY) / medianCmPerPx > 0.12) {
      cmPerPxX = medianCmPerPx;
      cmPerPxY = medianCmPerPx;
    }

    // Resolve any open-plan rooms where one axis matched the consensus scale
    for (const fb of fallbackAxisScales) {
      let bestS: number | null = null;
      let bestRelErr = 0.2;
      for (const s of fb.scales) {
        const relErr = Math.abs(s - medianCmPerPx) / medianCmPerPx;
        if (relErr < bestRelErr) {
          bestRelErr = relErr;
          bestS = s;
        }
      }
      if (bestS !== null) {
        prelimMatched[fb.idx].impliedCmPerPx = bestS;
        prelimMatched[fb.idx].matchedSpanPx = fb.spanPx;
      }
    }
  } else if (fallbackAxisScales.length > 0) {
    const allScales = fallbackAxisScales.flatMap((f) => f.scales).sort((a, b) => a - b);
    if (allScales.length > 0) {
      const mid = Math.floor(allScales.length / 2);
      medianCmPerPx = allScales[mid];
      cmPerPxX = medianCmPerPx;
      cmPerPxY = medianCmPerPx;
    }
  }

  const effectiveScaleX = cmPerPxX ?? medianCmPerPx;
  const calibratedWidthMeters =
    effectiveScaleX !== null
      ? Math.round(((spanPxW * effectiveScaleX) / 100) * 100) / 100
      : null;

  const detectedUnit: Unit | null =
    candidates.length > 0 ? candidates[0].unit : null;

  const finalScaleX = cmPerPxX || medianCmPerPx || 1;
  const finalScaleY = cmPerPxY || medianCmPerPx || 1;
  const matched: DetectedDimension[] = prelimMatched.map((item) => ({
    rawText: item.cand.rawText,
    kind: item.cand.kind,
    unit: item.cand.unit,
    widthCm: item.cand.val1Cm,
    heightCm: item.cand.val2Cm,
    xCm: Math.round(item.cand.cxPx * finalScaleX + ORIGIN_OFFSET_X),
    yCm: Math.round(item.cand.cyPx * finalScaleY + ORIGIN_OFFSET_Y),
    matchedSpanPx: item.matchedSpanPx,
    impliedCmPerPx: item.impliedCmPerPx,
  }));

  return {
    matched,
    calibratedWidthMeters,
    detectedUnit,
    cmPerPx: medianCmPerPx,
    cmPerPxX,
    cmPerPxY,
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
    [/\bliving\s*(&|and|\/)?\s*dining\b/i, 'Living / Dining'],
    [/\bdining\s+room\b/i, 'Dining Room'],
    [/\bliving(\s+room|\s+area|\/)?\b/i, 'Living Room'],
    [/\bdining(\s+area)?\b/i, 'Dining'],
    [/\bkitchen(ette)?\b/i, 'Kitchen'],
    [/\bbath(room)?\s*\d*\b/i, 'Bath'],
    [/\b(restroom|powder\s*room|wc)\b/i, 'Bath'],
    [/\b(home\s+)?(office|study|den)\b/i, 'Study'],
    [/\b(walk[- ]?in\s+)?closet\b/i, 'Closet'],
    [/\b(foyer|entry(way)?|vestibule)\b/i, 'Foyer'],
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
 * Runs client-side Tesseract OCR on the floorplan image and extracts:
 * 1. Printed dimension strings ("9'3\" x 7'10\"", "5.2m x 3.4m") for scale calibration
 * 2. All text bounding boxes (so text regions are masked out from wall detection)
 */
export async function extractOcrDimensionsFromImage(
  img: HTMLImageElement,
  invert = false
): Promise<{
  dimensions: RawDimensionCandidate[];
  roomNames: RawRoomNameCandidate[];
  textBoxes: OcrTextBoxPx[];
}> {
  const naturalW = img.naturalWidth || img.width || 600;
  const naturalH = img.naturalHeight || img.height || 450;

  const maxNatural = Math.max(naturalW, naturalH);
  const ocrScale =
    maxNatural < 900 ? Math.min(2.0, 1200 / maxNatural) : Math.min(1.0, 1600 / maxNatural);
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
    const textBoxes: OcrTextBoxPx[] = [];

    const blocks = result.data?.blocks || [];
    for (const block of blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          if (!line.bbox) continue;
          const x0Px = Math.floor((line.bbox.x0 / ocrW) * procW);
          const y0Px = Math.floor((line.bbox.y0 / ocrH) * procH);
          const x1Px = Math.ceil((line.bbox.x1 / ocrW) * procW);
          const y1Px = Math.ceil((line.bbox.y1 / ocrH) * procH);
          const cxPx = (x0Px + x1Px) / 2;
          const cyPx = (y0Px + y1Px) / 2;

          // Record text box if it contains alphanumeric letters/digits (not vertical wall pipes "|")
          if (/[a-zA-Z0-9]{2,}/.test(line.text) && y1Px - y0Px < procH * 0.12) {
            textBoxes.push({ x0: x0Px, y0: y0Px, x1: x1Px, y1: y1Px });
          }

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
        }
      }
    }

    return { dimensions, roomNames, textBoxes };
  } finally {
    await worker.terminate();
  }
}

/**
 * Topological Graph Regularizer:
 * 1. Groups collinear wall segments within tight pixel-jitter tolerance (preserving architectural steps).
 * 2. Detects collinear and corner-connected doorway/window openings and bridges the underlying wall.
 * 3. Snaps perpendicular L, T, and + corner junctions and small step offsets so rooms form closed polygons.
 */
export function regularizeFloorplanGraph(
  segmentsCm: RawSegment[],
  rawBinaryMask: Uint8Array | null,
  structuralMask: Uint8Array | null,
  maskWidth: number,
  maskHeight: number,
  cmPerPx: number,
  _minWallLengthCm: number,
  detectOpenings: boolean,
  winBandsCm: RawSegment[] = [],
  cmPerPxX: number = cmPerPx,
  cmPerPxY: number = cmPerPx
): { walls: Wall[]; doors: Door[]; windows: WindowItem[] } {
  const pxToCm = (px: number) => Math.round(px * cmPerPx);
  const collinearToleranceCm = Math.max(4, Math.round(cmPerPx * 2.5));
  const touchingCollinearToleranceCm = Math.max(11, pxToCm(6));
  const smallGapBridgeCm = Math.max(10, pxToCm(7));
  const maxDoorWidthCm = Math.max(115, pxToCm(54));
  const maxCornerDoorWidthCm = Math.max(105, pxToCm(52));
  const maxExteriorWindowCm = Math.max(480, pxToCm(240));
  const minOpeningWidthCm = Math.max(26, pxToCm(14));
  const cornerSnapToleranceCm = Math.max(16, pxToCm(12));
  const stepMinCm = Math.max(12, pxToCm(7));
  const stepMaxCm = Math.max(30, pxToCm(18));
  const stepEndTolCm = Math.max(20, pxToCm(14));
  const minSegLenCm = Math.max(8, pxToCm(4));

  const hSegs = segmentsCm.filter((s) => s.axis === 'h').sort((a, b) => a.pos - b.pos);
  const vSegs = segmentsCm.filter((s) => s.axis === 'v').sort((a, b) => a.pos - b.pos);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of [...segmentsCm, ...winBandsCm]) {
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

  function isExteriorSpan(
    axis: 'h' | 'v',
    posCm: number,
    startCm: number,
    endCm: number
  ): boolean {
    const midCm = (startCm + endCm) / 2;
    const rayPadCm = pxToCm(12);
    const minBlockerLen = pxToCm(16);
    const maxBlockerDist = pxToCm(180);

    const hasPerpBridgeBetween = (perpAxis: 'h' | 'v', c1: number, c2: number): boolean => {
      const lo = Math.min(c1, c2);
      const hi = Math.max(c1, c2);
      const span = hi - lo;
      if (span <= pxToCm(25)) return true;
      const perpList = perpAxis === 'v' ? vSegs : hSegs;
      let totalOverlap = 0;
      for (const p of perpList) {
        const overlap = Math.min(p.end, hi) - Math.max(p.start, lo);
        if (overlap > 0) {
          if (overlap >= span * 0.45) return true;
          totalOverlap += overlap;
        }
      }
      return totalOverlap >= span * 0.45;
    };

    if (axis === 'h') {
      const blockedNorth = hSegs.some(
        (s) =>
          s.end - s.start >= minBlockerLen &&
          s.pos < posCm - rayPadCm &&
          posCm - s.pos <= maxBlockerDist &&
          s.start - rayPadCm <= midCm &&
          s.end + rayPadCm >= midCm &&
          hasPerpBridgeBetween('v', s.pos, posCm)
      );
      const blockedSouth = hSegs.some(
        (s) =>
          s.end - s.start >= minBlockerLen &&
          s.pos > posCm + rayPadCm &&
          s.pos - posCm <= maxBlockerDist &&
          s.start - rayPadCm <= midCm &&
          s.end + rayPadCm >= midCm &&
          hasPerpBridgeBetween('v', posCm, s.pos)
      );
      return !(blockedNorth && blockedSouth);
    } else {
      const blockedWest = vSegs.some(
        (s) =>
          s.end - s.start >= minBlockerLen &&
          s.pos < posCm - rayPadCm &&
          posCm - s.pos <= maxBlockerDist &&
          s.start - rayPadCm <= midCm &&
          s.end + rayPadCm >= midCm &&
          hasPerpBridgeBetween('h', s.pos, posCm)
      );
      const blockedEast = vSegs.some(
        (s) =>
          s.end - s.start >= minBlockerLen &&
          s.pos > posCm + rayPadCm &&
          s.pos - posCm <= maxBlockerDist &&
          s.start - rayPadCm <= midCm &&
          s.end + rayPadCm >= midCm &&
          hasPerpBridgeBetween('h', posCm, s.pos)
      );
      return !(blockedWest && blockedEast);
    }
  }

  /**
   * Checks whether a span along a wall is on an exterior boundary and contains continuous thin
   * parallel window lines (at least 2 distinct parallel strokes across the span, without a door swing).
   */
  function hasWindowBandInRawMask(
    axis: 'h' | 'v',
    posCm: number,
    startCm: number,
    endCm: number
  ): boolean {
    if (!rawBinaryMask || cmPerPx <= 0) return false;
    if (!isExteriorSpan(axis, posCm, startCm, endCm)) return false;

    const posScale = axis === 'h' ? cmPerPxY : cmPerPxX;
    const spanScale = axis === 'h' ? cmPerPxX : cmPerPxY;
    const pxPos = Math.round(posCm / posScale);
    const pxStart = Math.round(Math.min(startCm, endCm) / spanScale);
    const pxEnd = Math.round(Math.max(startCm, endCm) / spanScale);
    const span = pxEnd - pxStart;
    if (span < 12) return false;

    const ridgeBit = axis === 'h' ? 2 : 4;
    let covered = 0;
    let total = 0;
    let emptyRun = 0;
    let maxEmptyRun = 0;

    for (let t = pxStart + 2; t <= pxEnd - 2; t++) {
      total++;
      let ridgeRuns = 0;
      let rawRuns = 0;
      let inRidge = false;
      let inRaw = false;

      for (let d = -7; d <= 7; d++) {
        const rx = axis === 'h' ? t : pxPos + d;
        const ry = axis === 'h' ? pxPos + d : t;
        if (rx >= 0 && rx < maskWidth && ry >= 0 && ry < maskHeight) {
          const idx = ry * maskWidth + rx;
          const isStruct = structuralMask ? structuralMask[idx] === 1 : false;
          const val = rawBinaryMask[idx];
          const hasRidge = !isStruct && (val & ridgeBit) !== 0;
          const hasRaw = !isStruct && (val & 1) !== 0;

          if (hasRidge && !inRidge) {
            ridgeRuns++;
            inRidge = true;
          } else if (!hasRidge) {
            inRidge = false;
          }

          if (hasRaw && !inRaw) {
            rawRuns++;
            inRaw = true;
          } else if (!hasRaw) {
            inRaw = false;
          }
        } else {
          inRidge = false;
          inRaw = false;
        }
      }

      if (ridgeRuns >= 2 || rawRuns >= 2) {
        covered++;
        emptyRun = 0;
      } else {
        emptyRun++;
        if (emptyRun > maxEmptyRun) maxEmptyRun = emptyRun;
      }
    }

    return (
      total > 0 &&
      covered / total >= 0.62 &&
      maxEmptyRun <= Math.max(6, Math.round(span * 0.15))
    );
  }

  /**
   * Verifies that a candidate doorway gap is not an empty open-plan room passage nor blocked
   * by an intersecting structural wall, and contains thin door leaf / swing arc / bi-fold pixels.
   */
  function hasDoorSignatureInRawMask(
    axis: 'h' | 'v',
    posCm: number,
    startCm: number,
    endCm: number
  ): boolean {
    if (!rawBinaryMask || cmPerPx <= 0) return true;
    const posScale = axis === 'h' ? cmPerPxY : cmPerPxX;
    const spanScale = axis === 'h' ? cmPerPxX : cmPerPxY;
    const pxPos = Math.round(posCm / posScale);
    const pxStart = Math.round(Math.min(startCm, endCm) / spanScale);
    const pxEnd = Math.round(Math.max(startCm, endCm) / spanScale);
    const span = pxEnd - pxStart;
    if (span < 10) return false;

    let thinPixels = 0;
    let nearLineThinPixels = 0;
    let swingZoneThinPixels = 0;
    let structBlockedCols = 0;
    const searchDepth = Math.min(28, Math.max(14, Math.round(span * 0.65)));

    for (let t = pxStart; t <= pxEnd; t++) {
      const isDeepInterior = t >= pxStart + 4 && t <= pxEnd - 4;
      let colHasStructOnLine = false;
      for (let d = -searchDepth; d <= searchDepth; d++) {
        const rx = axis === 'h' ? t : pxPos + d;
        const ry = axis === 'h' ? pxPos + d : t;
        if (rx >= 0 && rx < maskWidth && ry >= 0 && ry < maskHeight) {
          const idx = ry * maskWidth + rx;
          const isStruct = structuralMask ? structuralMask[idx] === 1 : false;
          if (isDeepInterior && Math.abs(d) <= 1 && isStruct) {
            colHasStructOnLine = true;
          }
          if (rawBinaryMask[idx] && !isStruct) {
            thinPixels++;
            if (Math.abs(d) <= 7) {
              nearLineThinPixels++;
            }
            if (Math.abs(d) >= 2) {
              swingZoneThinPixels++;
            }
          }
        }
      }
      if (colHasStructOnLine) {
        structBlockedCols++;
      }
    }
    if (structBlockedCols >= 3) return false;
    return nearLineThinPixels >= 2 && swingZoneThinPixels >= 4 && thinPixels >= 8;
  }

  /**
   * Extends a wall segment's start and end coordinates across any contiguous thick structural
   * pier / Poché block in structuralMask so walls and facade window bands connect through piers.
   */
  function extendSpanThroughStructuralPiers(
    axis: 'h' | 'v',
    posCm: number,
    startCm: number,
    endCm: number,
    allowMullionGapPx = 0
  ): { startCm: number; endCm: number } {
    if (!structuralMask || cmPerPx <= 0) return { startCm, endCm };
    const posScale = axis === 'h' ? cmPerPxY : cmPerPxX;
    const spanScale = axis === 'h' ? cmPerPxX : cmPerPxY;
    const pxPos = Math.round(posCm / posScale);
    let pxStart = Math.round(startCm / spanScale);
    let pxEnd = Math.round(endCm / spanScale);
    const maxPierPx = 64;

    const hasStructAt = (t: number): boolean => {
      for (let d = -4; d <= 4; d++) {
        const rx = axis === 'h' ? t : pxPos + d;
        const ry = axis === 'h' ? pxPos + d : t;
        if (rx >= 0 && rx < maskWidth && ry >= 0 && ry < maskHeight) {
          if (structuralMask[ry * maskWidth + rx]) return true;
        }
      }
      return false;
    };

    if (!hasStructAt(pxStart - 1) && allowMullionGapPx > 0) {
      for (let g = 1; g <= allowMullionGapPx; g++) {
        if (pxStart - g >= 0 && hasStructAt(pxStart - g)) {
          pxStart -= g;
          break;
        }
      }
    }
    let steps = 0;
    while (pxStart > 0 && steps < maxPierPx && hasStructAt(pxStart - 1)) {
      pxStart--;
      steps++;
    }

    const maxLimit = axis === 'h' ? maskWidth - 1 : maskHeight - 1;
    if (!hasStructAt(pxEnd + 1) && allowMullionGapPx > 0) {
      for (let g = 1; g <= allowMullionGapPx; g++) {
        if (pxEnd + g <= maxLimit && hasStructAt(pxEnd + g)) {
          pxEnd += g;
          break;
        }
      }
    }
    steps = 0;
    while (pxEnd < maxLimit && steps < maxPierPx && hasStructAt(pxEnd + 1)) {
      pxEnd++;
      steps++;
    }

    return {
      startCm: pxStart < Math.round(startCm / spanScale) ? pxStart * spanScale : startCm,
      endCm: pxEnd > Math.round(endCm / spanScale) ? pxEnd * spanScale : endCm,
    };
  }

  function formatWindowWidth(gapCm: number): number {
    return Math.round(Math.max(pxToCm(28), gapCm * 0.95) / 5) * 5;
  }

  function formatDoorWidth(gapCm: number): number {
    const minD = Math.max(55, pxToCm(26));
    const maxD = Math.max(95, pxToCm(52));
    return Math.round(Math.min(maxD, Math.max(minD, gapCm * 0.92)) / 5) * 5;
  }

  function mergeAndExtractLineGroup(
    group: RawSegment[],
    axis: 'h' | 'v'
  ): RawSegment[] {
    if (group.length === 0) return [];

    interface WeightedInterval {
      start: number;
      end: number;
      posWeight: number;
      thickWeight: number;
      totalLen: number;
    }

    const sortedIntervals: WeightedInterval[] = [...group]
      .map((s) => {
        const ext = extendSpanThroughStructuralPiers(axis, s.pos, s.start, s.end);
        const len = Math.max(1, ext.endCm - ext.startCm);
        return {
          start: ext.startCm,
          end: ext.endCm,
          posWeight: s.pos * len,
          thickWeight: s.thickness * len,
          totalLen: len,
        };
      })
      .sort((a, b) => a.start - b.start);

    const merged: WeightedInterval[] = [];
    for (const interval of sortedIntervals) {
      if (merged.length === 0) {
        merged.push({ ...interval });
      } else {
        const prev = merged[merged.length - 1];
        if (interval.start - prev.end <= smallGapBridgeCm) {
          prev.end = Math.max(prev.end, interval.end);
          prev.posWeight += interval.posWeight;
          prev.thickWeight += interval.thickWeight;
          prev.totalLen += interval.totalLen;
        } else {
          merged.push({ ...interval });
        }
      }
    }

    if (!detectOpenings || merged.length <= 1) {
      return merged.map((m) => ({
        axis,
        pos: Math.round(m.posWeight / m.totalLen),
        start: m.start,
        end: m.end,
        thickness: Math.min(25, Math.max(12, Math.round(m.thickWeight / m.totalLen / 5) * 5)),
      }));
    }

    const bridged: WeightedInterval[] = [merged[0]];

    for (let i = 1; i < merged.length; i++) {
      const prev = bridged[bridged.length - 1];
      const curr = merged[i];
      const gapWidth = curr.start - prev.end;
      const combinedPos = Math.round(
        (prev.posWeight + curr.posWeight) / (prev.totalLen + curr.totalLen)
      );
      const combinedThick = Math.min(
        25,
        Math.max(
          12,
          Math.round(((prev.thickWeight + curr.thickWeight) / (prev.totalLen + curr.totalLen)) / 5) * 5
        )
      );

      const isWindowSpan =
        gapWidth >= minOpeningWidthCm &&
        gapWidth <= maxExteriorWindowCm &&
        hasWindowBandInRawMask(axis, combinedPos, prev.end, curr.start);

      const isStandardOpening =
        !isWindowSpan &&
        gapWidth >= minOpeningWidthCm &&
        gapWidth <= maxDoorWidthCm &&
        hasDoorSignatureInRawMask(axis, combinedPos, prev.end, curr.start);

      if (isWindowSpan || isStandardOpening) {
        const gapCenter = Math.round((prev.end + curr.start) / 2);

        if (isWindowSpan) {
          windows.push({
            id: `win_imp_${windows.length + 1}_${Date.now().toString(36)}`,
            x: axis === 'h' ? gapCenter + ORIGIN_OFFSET_X : combinedPos + ORIGIN_OFFSET_X,
            y: axis === 'h' ? combinedPos + ORIGIN_OFFSET_Y : gapCenter + ORIGIN_OFFSET_Y,
            width: formatWindowWidth(gapWidth),
            thickness: combinedThick,
            rotation: axis === 'h' ? 0 : 90,
          });
        } else {
          doors.push({
            id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
            x: axis === 'h' ? gapCenter + ORIGIN_OFFSET_X : combinedPos + ORIGIN_OFFSET_X,
            y: axis === 'h' ? combinedPos + ORIGIN_OFFSET_Y : gapCenter + ORIGIN_OFFSET_Y,
            width: formatDoorWidth(gapWidth),
            rotation: axis === 'h' ? 0 : 90,
            swingDirection: 'left',
          });
        }

        prev.end = curr.end;
        prev.posWeight += curr.posWeight;
        prev.thickWeight += curr.thickWeight;
        prev.totalLen += curr.totalLen;
      } else {
        bridged.push(curr);
      }
    }

    return bridged.map((m) => {
      const finalPos = Math.round(m.posWeight / m.totalLen);
      const finalThick = Math.min(25, Math.max(12, Math.round(m.thickWeight / m.totalLen / 5) * 5));
      return {
        axis,
        pos: finalPos,
        start: m.start,
        end: m.end,
        thickness: finalThick,
      };
    });
  }

  function groupCollinear(segs: RawSegment[], axis: 'h' | 'v'): RawSegment[] {
    const groups: RawSegment[][] = [];

    // Pass 1: Group strictly collinear segments (within 2.5px)
    for (const seg of segs) {
      let matchedGroup: RawSegment[] | null = null;
      for (const grp of groups) {
        const totalWeight = grp.reduce((acc, item) => acc + Math.max(1, item.end - item.start), 0);
        const groupAvgPos =
          grp.reduce((acc, item) => acc + item.pos * Math.max(1, item.end - item.start), 0) /
          totalWeight;
        if (Math.abs(seg.pos - groupAvgPos) <= collinearToleranceCm) {
          matchedGroup = grp;
          break;
        }
      }
      if (matchedGroup) {
        matchedGroup.push(seg);
      } else {
        groups.push([seg]);
      }
    }

    // Pass 2: Merge adjacent groups within touchingCollinearToleranceCm (6px) that touch or overlap end-to-end
    let mergedAny = true;
    while (mergedAny) {
      mergedAny = false;
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const g1 = groups[i];
          const g2 = groups[j];
          const w1 = g1.reduce((acc, item) => acc + Math.max(1, item.end - item.start), 0);
          const avg1 = g1.reduce((acc, item) => acc + item.pos * Math.max(1, item.end - item.start), 0) / w1;
          const w2 = g2.reduce((acc, item) => acc + Math.max(1, item.end - item.start), 0);
          const avg2 = g2.reduce((acc, item) => acc + item.pos * Math.max(1, item.end - item.start), 0) / w2;
          if (
            Math.abs(avg1 - avg2) <= touchingCollinearToleranceCm &&
            g1.some((s1) =>
              g2.some((s2) => Math.max(s1.start - s2.end, s2.start - s1.end) <= smallGapBridgeCm)
            )
          ) {
            g1.push(...g2);
            groups.splice(j, 1);
            mergedAny = true;
            break;
          }
        }
        if (mergedAny) break;
      }
    }

    const result: RawSegment[] = [];
    for (const grp of groups) {
      result.push(...mergeAndExtractLineGroup(grp, axis));
    }
    return result;
  }

  const cleanH = groupCollinear(hSegs, 'h');
  const cleanV = groupCollinear(vSegs, 'v');

  // 1. Connect small architectural steps between adjacent horizontal walls before corner-opening detection
  for (let i = 0; i < cleanH.length; i++) {
    for (let j = i + 1; j < cleanH.length; j++) {
      const h1 = cleanH[i];
      const h2 = cleanH[j];
      const stepY = Math.abs(h1.pos - h2.pos);
      if (stepY < stepMinCm || stepY > stepMaxCm) continue;

      if (Math.abs(h1.end - h2.start) <= stepEndTolCm) {
        const xMid = h1.end > h2.start ? h2.start : Math.round((h1.end + h2.start) / 2);
        const yMin = Math.min(h1.pos, h2.pos);
        const yMax = Math.max(h1.pos, h2.pos);
        const existingV = cleanV.find(
          (v) =>
            Math.abs(v.pos - xMid) <= pxToCm(10) &&
            v.start <= yMax + pxToCm(10) &&
            v.end >= yMin - pxToCm(10)
        );
        if (existingV) {
          h1.end = existingV.pos;
          h2.start = existingV.pos;
          existingV.start = Math.min(existingV.start, yMin);
          existingV.end = Math.max(existingV.end, yMax);
        } else {
          h1.end = xMid;
          h2.start = xMid;
          cleanV.push({
            axis: 'v',
            pos: xMid,
            start: yMin,
            end: yMax,
            thickness: Math.min(h1.thickness, h2.thickness),
          });
        }
      } else if (Math.abs(h2.end - h1.start) <= stepEndTolCm) {
        const xMid = h2.end > h1.start ? h1.start : Math.round((h2.end + h1.start) / 2);
        const yMin = Math.min(h1.pos, h2.pos);
        const yMax = Math.max(h1.pos, h2.pos);
        const existingV = cleanV.find(
          (v) =>
            Math.abs(v.pos - xMid) <= pxToCm(10) &&
            v.start <= yMax + pxToCm(10) &&
            v.end >= yMin - pxToCm(10)
        );
        if (existingV) {
          h2.end = existingV.pos;
          h1.start = existingV.pos;
          existingV.start = Math.min(existingV.start, yMin);
          existingV.end = Math.max(existingV.end, yMax);
        } else {
          h2.end = xMid;
          h1.start = xMid;
          cleanV.push({
            axis: 'v',
            pos: xMid,
            start: yMin,
            end: yMax,
            thickness: Math.min(h1.thickness, h2.thickness),
          });
        }
      }
    }
  }

  // 2. Connect small architectural steps between adjacent vertical walls
  for (let i = 0; i < cleanV.length; i++) {
    for (let j = i + 1; j < cleanV.length; j++) {
      const v1 = cleanV[i];
      const v2 = cleanV[j];
      const stepX = Math.abs(v1.pos - v2.pos);
      if (stepX < stepMinCm || stepX > stepMaxCm) continue;

      if (Math.abs(v1.end - v2.start) <= stepEndTolCm) {
        const yMid = Math.round((v1.end + v2.start) / 2);
        const xMin = Math.min(v1.pos, v2.pos);
        const xMax = Math.max(v1.pos, v2.pos);
        const existingH = cleanH.find(
          (h) =>
            Math.abs(h.pos - yMid) <= pxToCm(10) &&
            h.start <= xMax + pxToCm(10) &&
            h.end >= xMin - pxToCm(10)
        );
        if (existingH) {
          v1.end = existingH.pos;
          v2.start = existingH.pos;
          existingH.start = Math.min(existingH.start, xMin);
          existingH.end = Math.max(existingH.end, xMax);
        } else {
          v1.end = yMid;
          v2.start = yMid;
          cleanH.push({
            axis: 'h',
            pos: yMid,
            start: xMin,
            end: xMax,
            thickness: Math.min(v1.thickness, v2.thickness),
          });
        }
      } else if (Math.abs(v2.end - v1.start) <= stepEndTolCm) {
        const yMid = Math.round((v2.end + v1.start) / 2);
        const xMin = Math.min(v1.pos, v2.pos);
        const xMax = Math.max(v1.pos, v2.pos);
        const existingH = cleanH.find(
          (h) =>
            Math.abs(h.pos - yMid) <= pxToCm(10) &&
            h.start <= xMax + pxToCm(10) &&
            h.end >= xMin - pxToCm(10)
        );
        if (existingH) {
          v2.end = existingH.pos;
          v1.start = existingH.pos;
          existingH.start = Math.min(existingH.start, xMin);
          existingH.end = Math.max(existingH.end, xMax);
        } else {
          v2.end = yMid;
          v1.start = yMid;
          cleanH.push({
            axis: 'h',
            pos: yMid,
            start: xMin,
            end: xMax,
            thickness: Math.min(v1.thickness, v2.thickness),
          });
        }
      }
    }
  }

  const vTouchesH = (xPos: number, yEnd: number) =>
    cleanH.some(
      (h) =>
        Math.abs(h.pos - yEnd) <= cornerSnapToleranceCm &&
        xPos >= h.start - cornerSnapToleranceCm &&
        xPos <= h.end + cornerSnapToleranceCm
    );

  const hTouchesV = (yPos: number, xEnd: number) =>
    cleanV.some(
      (v) =>
        Math.abs(v.pos - xEnd) <= cornerSnapToleranceCm &&
        yPos >= v.start - cornerSnapToleranceCm &&
        yPos <= v.end + cornerSnapToleranceCm
    );

  // Detect corner-connected doors and windows (where one side of the opening is a perpendicular wall)
  if (detectOpenings) {
    for (const v of cleanV) {
      if (!vTouchesH(v.pos, v.start)) {
        let bestTopH: RawSegment | null = null;
        let bestTopGap = Infinity;
        for (const h of cleanH) {
          const coversV = v.pos >= h.start - pxToCm(3) && v.pos <= h.end + pxToCm(3);
          const nearUnconnectedEnd =
            (Math.abs(v.pos - h.start) <= cornerSnapToleranceCm && !hTouchesV(h.pos, h.start)) ||
            (Math.abs(v.pos - h.end) <= cornerSnapToleranceCm && !hTouchesV(h.pos, h.end));
          if (coversV || nearUnconnectedEnd) {
            const gap = v.start - h.pos;
            if (gap > cornerSnapToleranceCm && gap < bestTopGap) {
              bestTopGap = gap;
              bestTopH = h;
            }
          }
        }
        if (bestTopH) {
          const isWin =
            bestTopGap >= minOpeningWidthCm &&
            bestTopGap <= maxExteriorWindowCm &&
            hasWindowBandInRawMask('v', v.pos, bestTopH.pos, v.start);
          const hTerminatesNearV =
            Math.abs(bestTopH.start - v.pos) <= cornerSnapToleranceCm * 1.4 ||
            Math.abs(bestTopH.end - v.pos) <= cornerSnapToleranceCm * 1.4 ||
            (v.end - v.start <= pxToCm(25) && vTouchesH(v.pos, v.end));
          const isDoor =
            !isWin &&
            bestTopGap >= minOpeningWidthCm &&
            bestTopGap <= maxCornerDoorWidthCm &&
            hTerminatesNearV &&
            hasDoorSignatureInRawMask('v', v.pos, bestTopH.pos, v.start);
          if (isWin || isDoor) {
            const center = Math.round((bestTopH.pos + v.start) / 2);
            if (isWin) {
              windows.push({
                id: `win_imp_${windows.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(v.pos + ORIGIN_OFFSET_X),
                y: Math.round(center + ORIGIN_OFFSET_Y),
                width: formatWindowWidth(bestTopGap),
                thickness: v.thickness,
                rotation: 90,
              });
            } else {
              doors.push({
                id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(v.pos + ORIGIN_OFFSET_X),
                y: Math.round(center + ORIGIN_OFFSET_Y),
                width: formatDoorWidth(bestTopGap),
                rotation: 90,
                swingDirection: 'left',
              });
            }
            v.start = bestTopH.pos;
          }
        }
      }

      let bestBotH: RawSegment | null = null;
      let bestBotGap = Infinity;
      for (const h of cleanH) {
        const coversV = v.pos >= h.start - pxToCm(3) && v.pos <= h.end + pxToCm(3);
        const nearUnconnectedEnd =
          (Math.abs(v.pos - h.start) <= cornerSnapToleranceCm && !hTouchesV(h.pos, h.start)) ||
          (Math.abs(v.pos - h.end) <= cornerSnapToleranceCm && !hTouchesV(h.pos, h.end));
        if (coversV || nearUnconnectedEnd) {
          const gap = h.pos - v.end;
          if (gap > cornerSnapToleranceCm && gap < bestBotGap) {
            bestBotGap = gap;
            bestBotH = h;
          }
        }
      }
      if (bestBotH) {
        const botHEndpointDangling =
          (Math.abs(bestBotH.start - v.pos) <= cornerSnapToleranceCm * 1.4 &&
            !hTouchesV(bestBotH.pos, bestBotH.start)) ||
          (Math.abs(bestBotH.end - v.pos) <= cornerSnapToleranceCm * 1.4 &&
            !hTouchesV(bestBotH.pos, bestBotH.end));
        if (!vTouchesH(v.pos, v.end) || botHEndpointDangling) {
          const isWin =
            bestBotGap >= minOpeningWidthCm &&
            bestBotGap <= maxExteriorWindowCm &&
            hasWindowBandInRawMask('v', v.pos, v.end, bestBotH.pos);
          const hTerminatesNearV =
            Math.abs(bestBotH.start - v.pos) <= cornerSnapToleranceCm * 1.4 ||
            Math.abs(bestBotH.end - v.pos) <= cornerSnapToleranceCm * 1.4 ||
            (v.end - v.start <= pxToCm(25) && vTouchesH(v.pos, v.start));
          const isDoor =
            !isWin &&
            bestBotGap >= minOpeningWidthCm &&
            bestBotGap <= maxCornerDoorWidthCm &&
            hTerminatesNearV &&
            hasDoorSignatureInRawMask('v', v.pos, v.end, bestBotH.pos);
          if (isWin || isDoor) {
            const center = Math.round((v.end + bestBotH.pos) / 2);
            if (isWin) {
              windows.push({
                id: `win_imp_${windows.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(v.pos + ORIGIN_OFFSET_X),
                y: Math.round(center + ORIGIN_OFFSET_Y),
                width: formatWindowWidth(bestBotGap),
                thickness: v.thickness,
                rotation: 90,
              });
            } else {
              doors.push({
                id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(v.pos + ORIGIN_OFFSET_X),
                y: Math.round(center + ORIGIN_OFFSET_Y),
                width: formatDoorWidth(bestBotGap),
                rotation: 90,
                swingDirection: 'left',
              });
            }
            v.end = bestBotH.pos;
          }
        }
      }
    }

    for (const h of cleanH) {
      if (!hTouchesV(h.pos, h.start)) {
        let bestLeftV: RawSegment | null = null;
        let bestLeftGap = Infinity;
        for (const v of cleanV) {
          const coversH = h.pos >= v.start - pxToCm(3) && h.pos <= v.end + pxToCm(3);
          const nearUnconnectedEnd =
            (Math.abs(h.pos - v.start) <= cornerSnapToleranceCm && !vTouchesH(v.pos, v.start)) ||
            (Math.abs(h.pos - v.end) <= cornerSnapToleranceCm && !vTouchesH(v.pos, v.end));
          if (coversH || nearUnconnectedEnd) {
            const gap = h.start - v.pos;
            if (gap > cornerSnapToleranceCm && gap < bestLeftGap) {
              bestLeftGap = gap;
              bestLeftV = v;
            }
          }
        }
        if (bestLeftV) {
          const isWin =
            bestLeftGap >= minOpeningWidthCm &&
            bestLeftGap <= maxExteriorWindowCm &&
            hasWindowBandInRawMask('h', h.pos, bestLeftV.pos, h.start);
          const vTerminatesNearH =
            Math.abs(bestLeftV.start - h.pos) <= cornerSnapToleranceCm * 1.4 ||
            Math.abs(bestLeftV.end - h.pos) <= cornerSnapToleranceCm * 1.4 ||
            (h.end - h.start <= pxToCm(25) && hTouchesV(h.pos, h.end));
          const isDoor =
            !isWin &&
            bestLeftGap >= minOpeningWidthCm &&
            bestLeftGap <= maxCornerDoorWidthCm &&
            vTerminatesNearH &&
            hasDoorSignatureInRawMask('h', h.pos, bestLeftV.pos, h.start);
          if (isWin || isDoor) {
            const center = Math.round((bestLeftV.pos + h.start) / 2);
            if (isWin) {
              windows.push({
                id: `win_imp_${windows.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(center + ORIGIN_OFFSET_X),
                y: Math.round(h.pos + ORIGIN_OFFSET_Y),
                width: formatWindowWidth(bestLeftGap),
                thickness: h.thickness,
                rotation: 0,
              });
            } else {
              doors.push({
                id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(center + ORIGIN_OFFSET_X),
                y: Math.round(h.pos + ORIGIN_OFFSET_Y),
                width: formatDoorWidth(bestLeftGap),
                rotation: 0,
                swingDirection: 'left',
              });
            }
            h.start = bestLeftV.pos;
          }
        }
      }

      if (!hTouchesV(h.pos, h.end)) {
        let bestRightV: RawSegment | null = null;
        let bestRightGap = Infinity;
        for (const v of cleanV) {
          const coversH = h.pos >= v.start - pxToCm(3) && h.pos <= v.end + pxToCm(3);
          const nearUnconnectedEnd =
            (Math.abs(h.pos - v.start) <= cornerSnapToleranceCm && !vTouchesH(v.pos, v.start)) ||
            (Math.abs(h.pos - v.end) <= cornerSnapToleranceCm && !vTouchesH(v.pos, v.end));
          if (coversH || nearUnconnectedEnd) {
            const gap = v.pos - h.end;
            if (gap > cornerSnapToleranceCm && gap < bestRightGap) {
              bestRightGap = gap;
              bestRightV = v;
            }
          }
        }
        if (bestRightV) {
          const isWin =
            bestRightGap >= minOpeningWidthCm &&
            bestRightGap <= maxExteriorWindowCm &&
            hasWindowBandInRawMask('h', h.pos, h.end, bestRightV.pos);
          const vTerminatesNearH =
            Math.abs(bestRightV.start - h.pos) <= cornerSnapToleranceCm * 1.4 ||
            Math.abs(bestRightV.end - h.pos) <= cornerSnapToleranceCm * 1.4 ||
            (h.end - h.start <= pxToCm(25) && hTouchesV(h.pos, h.start));
          const isDoor =
            !isWin &&
            bestRightGap >= minOpeningWidthCm &&
            bestRightGap <= maxCornerDoorWidthCm &&
            vTerminatesNearH &&
            hasDoorSignatureInRawMask('h', h.pos, h.end, bestRightV.pos);
          if (isWin || isDoor) {
            const center = Math.round((h.end + bestRightV.pos) / 2);
            if (isWin) {
              windows.push({
                id: `win_imp_${windows.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(center + ORIGIN_OFFSET_X),
                y: Math.round(h.pos + ORIGIN_OFFSET_Y),
                width: formatWindowWidth(bestRightGap),
                thickness: h.thickness,
                rotation: 0,
              });
            } else {
              doors.push({
                id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(center + ORIGIN_OFFSET_X),
                y: Math.round(h.pos + ORIGIN_OFFSET_Y),
                width: formatDoorWidth(bestRightGap),
                rotation: 0,
                swingDirection: 'left',
              });
            }
            h.end = bestRightV.pos;
          }
        }
      }
    }

    // Detect closet/alcove doors spanning between two matching parallel side walls that both terminate at the opening line
    const sortedV = [...cleanV].sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < sortedV.length; i++) {
      for (let j = i + 1; j < sortedV.length; j++) {
        const v1 = sortedV[i];
        const v2 = sortedV[j];
        const gapX = v2.pos - v1.pos;
        if (gapX < minOpeningWidthCm || gapX > maxCornerDoorWidthCm) continue;

        const candidateYs: number[] = [];
        if (
          !vTouchesH(v1.pos, v1.start) &&
          !vTouchesH(v2.pos, v2.start) &&
          Math.abs(v1.start - v2.start) <= pxToCm(6) &&
          vTouchesH(v1.pos, v1.end) &&
          vTouchesH(v2.pos, v2.end)
        ) {
          candidateYs.push((v1.start + v2.start) / 2);
        }
        if (
          !vTouchesH(v1.pos, v1.end) &&
          !vTouchesH(v2.pos, v2.end) &&
          Math.abs(v1.end - v2.end) <= pxToCm(6) &&
          vTouchesH(v1.pos, v1.start) &&
          vTouchesH(v2.pos, v2.start)
        ) {
          candidateYs.push((v1.end + v2.end) / 2);
        }

        for (const y0 of candidateYs) {
          const blockedByMidV = sortedV.some(
            (vm, k) => k > i && k < j && y0 >= vm.start - pxToCm(4) && y0 <= vm.end + pxToCm(4)
          );
          if (blockedByMidV) continue;
          const alreadyHasH = cleanH.some(
            (h) =>
              Math.abs(h.pos - y0) <= cornerSnapToleranceCm &&
              Math.min(h.end, v2.pos) - Math.max(h.start, v1.pos) >= gapX * 0.5
          );
          if (alreadyHasH) continue;
          if (
            !hasWindowBandInRawMask('h', y0, v1.pos, v2.pos) &&
            hasDoorSignatureInRawMask('h', y0, v1.pos, v2.pos)
          ) {
            const center = Math.round((v1.pos + v2.pos) / 2);
            doors.push({
              id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
              x: Math.round(center + ORIGIN_OFFSET_X),
              y: Math.round(y0 + ORIGIN_OFFSET_Y),
              width: formatDoorWidth(gapX),
              rotation: 0,
              swingDirection: 'left',
            });
            cleanH.push({
              axis: 'h',
              pos: Math.round(y0),
              start: Math.round(v1.pos),
              end: Math.round(v2.pos),
              thickness: Math.min(v1.thickness, v2.thickness),
            });
          }
        }
      }
    }

    const sortedH = [...cleanH].sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < sortedH.length; i++) {
      for (let j = i + 1; j < sortedH.length; j++) {
        const h1 = sortedH[i];
        const h2 = sortedH[j];
        const gapY = h2.pos - h1.pos;
        if (gapY < minOpeningWidthCm || gapY > maxCornerDoorWidthCm) continue;

        const candidateXs: number[] = [];
        if (
          !hTouchesV(h1.pos, h1.start) &&
          !hTouchesV(h2.pos, h2.start) &&
          Math.abs(h1.start - h2.start) <= pxToCm(6) &&
          hTouchesV(h1.pos, h1.end) &&
          hTouchesV(h2.pos, h2.end)
        ) {
          candidateXs.push((h1.start + h2.start) / 2);
        }
        if (
          !hTouchesV(h1.pos, h1.end) &&
          !hTouchesV(h2.pos, h2.end) &&
          Math.abs(h1.end - h2.end) <= pxToCm(6) &&
          hTouchesV(h1.pos, h1.start) &&
          hTouchesV(h2.pos, h2.start)
        ) {
          candidateXs.push((h1.end + h2.end) / 2);
        }

        for (const x0 of candidateXs) {
          const blockedByMidH = sortedH.some(
            (hm, k) => k > i && k < j && x0 >= hm.start - pxToCm(4) && x0 <= hm.end + pxToCm(4)
          );
          if (blockedByMidH) continue;
          const alreadyHasV = cleanV.some(
            (v) =>
              Math.abs(v.pos - x0) <= cornerSnapToleranceCm &&
              Math.min(v.end, h2.pos) - Math.max(v.start, h1.pos) >= gapY * 0.5
          );
          if (alreadyHasV) continue;
          if (
            !hasWindowBandInRawMask('v', x0, h1.pos, h2.pos) &&
            hasDoorSignatureInRawMask('v', x0, h1.pos, h2.pos)
          ) {
            const center = Math.round((h1.pos + h2.pos) / 2);
            doors.push({
              id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
              x: Math.round(x0 + ORIGIN_OFFSET_X),
              y: Math.round(center + ORIGIN_OFFSET_Y),
              width: formatDoorWidth(gapY),
              rotation: 90,
              swingDirection: 'left',
            });
            cleanV.push({
              axis: 'v',
              pos: Math.round(x0),
              start: Math.round(h1.pos),
              end: Math.round(h2.pos),
              thickness: Math.min(h1.thickness, h2.thickness),
            });
          }
        }
      }
    }

    // Integrate multi-line exterior window bands (e.g. corner-meeting windows or floor-to-ceiling window walls)
    const exteriorWinBands = winBandsCm
      .filter((wb) => isExteriorSpan(wb.axis, wb.pos, wb.start, wb.end))
      .map((wb) => {
        const ext = extendSpanThroughStructuralPiers(wb.axis, wb.pos, wb.start, wb.end, 16);
        return {
          wb,
          extStart: ext.startCm,
          extEnd: ext.endCm,
        };
      });
    const endConnectTol = pxToCm(18);
    const collinearWinTol = pxToCm(10);

    const isEndpointConnected = (
      axis: 'h' | 'v',
      pos: number,
      endCoord: number,
      selfWb: RawSegment
    ): boolean => {
      const sameAxisWalls = axis === 'h' ? cleanH : cleanV;
      const perpAxisWalls = axis === 'h' ? cleanV : cleanH;
      const touchesCollinear = sameAxisWalls.some(
        (w) =>
          Math.abs(w.pos - pos) <= collinearWinTol &&
          (Math.abs(w.start - endCoord) <= endConnectTol ||
            Math.abs(w.end - endCoord) <= endConnectTol ||
            (endCoord >= w.start - endConnectTol && endCoord <= w.end + endConnectTol))
      );
      if (touchesCollinear) return true;

      const touchesPerpWall = perpAxisWalls.some(
        (w) =>
          Math.abs(w.pos - endCoord) <= endConnectTol &&
          pos >= w.start - endConnectTol &&
          pos <= w.end + endConnectTol
      );
      if (touchesPerpWall) return true;

      const touchesOtherWinBand = exteriorWinBands.some((other) => {
        if (other.wb === selfWb) return false;
        if (other.wb.axis !== axis) {
          return (
            Math.abs(other.wb.pos - endCoord) <= endConnectTol &&
            pos >= other.extStart - endConnectTol &&
            pos <= other.extEnd + endConnectTol
          );
        } else {
          return (
            Math.abs(other.wb.pos - pos) <= collinearWinTol &&
            (Math.abs(other.extStart - endCoord) <= endConnectTol ||
              Math.abs(other.extEnd - endCoord) <= endConnectTol)
          );
        }
      });
      return touchesOtherWinBand;
    };

    for (const item of exteriorWinBands) {
      const { wb, extStart, extEnd } = item;
      const startConn = isEndpointConnected(wb.axis, wb.pos, extStart, wb);
      const endConn = isEndpointConnected(wb.axis, wb.pos, extEnd, wb);
      const wbLen = wb.end - wb.start;
      if (!(startConn && endConn) && !((startConn || endConn) && wbLen >= pxToCm(38))) {
        continue;
      }

      const wbCenter = (wb.start + wb.end) / 2;
      const alreadyHasWin = windows.some((w) => {
        const isSameAxis = (wb.axis === 'h' && w.rotation === 0) || (wb.axis === 'v' && w.rotation === 90);
        if (!isSameAxis) return false;
        const wPos = wb.axis === 'h' ? w.y - ORIGIN_OFFSET_Y : w.x - ORIGIN_OFFSET_X;
        const wCenter = wb.axis === 'h' ? w.x - ORIGIN_OFFSET_X : w.y - ORIGIN_OFFSET_Y;
        return Math.abs(wPos - wb.pos) <= pxToCm(14) && Math.abs(wCenter - wbCenter) <= wbLen * 0.45;
      });

      const sameAxisWalls = wb.axis === 'h' ? cleanH : cleanV;
      const matchingWalls = sameAxisWalls.filter(
        (w) =>
          Math.abs(w.pos - wb.pos) <= collinearWinTol &&
          Math.max(w.start - extEnd, extStart - w.end) <= endConnectTol
      );

      let wallThickness = wb.thickness;
      if (matchingWalls.length > 0) {
        const primary = matchingWalls[0];
        primary.start = Math.min(primary.start, extStart);
        primary.end = Math.max(primary.end, extEnd);
        wallThickness = primary.thickness;
        for (let k = 1; k < matchingWalls.length; k++) {
          const extra = matchingWalls[k];
          primary.start = Math.min(primary.start, extra.start);
          primary.end = Math.max(primary.end, extra.end);
          const idx = sameAxisWalls.indexOf(extra);
          if (idx !== -1) sameAxisWalls.splice(idx, 1);
        }
      } else {
        sameAxisWalls.push({
          axis: wb.axis,
          pos: Math.round(wb.pos),
          start: Math.round(extStart),
          end: Math.round(extEnd),
          thickness: Math.max(12, Math.min(20, wb.thickness)),
        });
      }

      if (!alreadyHasWin) {
        windows.push({
          id: `win_imp_${windows.length + 1}_${Date.now().toString(36)}`,
          x: Math.round((wb.axis === 'h' ? wbCenter : wb.pos) + ORIGIN_OFFSET_X),
          y: Math.round((wb.axis === 'h' ? wb.pos : wbCenter) + ORIGIN_OFFSET_Y),
          width: formatWindowWidth(wbLen),
          thickness: wallThickness,
          rotation: wb.axis === 'h' ? 0 : 90,
        });
      }
    }

    // Bridge any remaining collinear doorway gaps (such as doorways between a solid wall and a newly integrated exterior window wall)
    const bridgeRemainingDoorwayGaps = (list: RawSegment[], axis: 'h' | 'v') => {
      const maxPosDiff = pxToCm(5);
      let changed = true;
      while (changed) {
        changed = false;
        list.sort((a, b) => a.pos - b.pos || a.start - b.start);
        for (let i = 0; i < list.length && !changed; i++) {
          for (let j = 0; j < list.length && !changed; j++) {
            if (i === j) continue;
            const a = list[i];
            const b = list[j];
            if (Math.abs(a.pos - b.pos) > maxPosDiff) continue;
            if (b.start < a.end - smallGapBridgeCm) continue;
            const gapWidth = b.start - a.end;
            const lenA = Math.max(1, a.end - a.start);
            const lenB = Math.max(1, b.end - b.start);
            const avgPos = Math.round((a.pos * lenA + b.pos * lenB) / (lenA + lenB));
            if (gapWidth <= smallGapBridgeCm) {
              a.pos = avgPos;
              a.start = Math.min(a.start, b.start);
              a.end = Math.max(a.end, b.end);
              list.splice(j, 1);
              changed = true;
            } else if (
              gapWidth >= minOpeningWidthCm &&
              gapWidth <= maxDoorWidthCm &&
              !hasWindowBandInRawMask(axis, avgPos, a.end, b.start) &&
              hasDoorSignatureInRawMask(axis, avgPos, a.end, b.start)
            ) {
              const gapCenter = Math.round((a.end + b.start) / 2);
              const alreadyHasDoor = doors.some((d) => {
                const dPos = axis === 'h' ? d.y - ORIGIN_OFFSET_Y : d.x - ORIGIN_OFFSET_X;
                const dCenter = axis === 'h' ? d.x - ORIGIN_OFFSET_X : d.y - ORIGIN_OFFSET_Y;
                return (
                  Math.abs(dPos - avgPos) <= pxToCm(12) &&
                  Math.abs(dCenter - gapCenter) <= gapWidth * 0.6
                );
              });
              if (!alreadyHasDoor) {
                doors.push({
                  id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                  x: Math.round((axis === 'h' ? gapCenter : avgPos) + ORIGIN_OFFSET_X),
                  y: Math.round((axis === 'h' ? avgPos : gapCenter) + ORIGIN_OFFSET_Y),
                  width: formatDoorWidth(gapWidth),
                  rotation: axis === 'h' ? 0 : 90,
                  swingDirection: 'left',
                });
              }
              a.pos = avgPos;
              a.start = Math.min(a.start, b.start);
              a.end = Math.max(a.end, b.end);
              list.splice(j, 1);
              changed = true;
            }
          }
        }
      }
    };

    bridgeRemainingDoorwayGaps(cleanH, 'h');
    bridgeRemainingDoorwayGaps(cleanV, 'v');
  }

  // Snap orthogonal L-corners and T-junctions between cleanH and cleanV
  // Crucial: only snap the closer endpoint (start vs end) and never collapse short L-corner walls!
  for (const h of cleanH) {
    for (const v of cleanV) {
      const hNearVYRange =
        h.pos >= v.start - cornerSnapToleranceCm && h.pos <= v.end + cornerSnapToleranceCm;
      if (hNearVYRange) {
        const dStart = Math.abs(h.start - v.pos);
        const dEnd = Math.abs(h.end - v.pos);
        if (dStart <= cornerSnapToleranceCm && dStart < dEnd && h.end - v.pos >= minSegLenCm) {
          h.start = v.pos;
        } else if (dEnd <= cornerSnapToleranceCm && dEnd < dStart && v.pos - h.start >= minSegLenCm) {
          h.end = v.pos;
        }
      }

      const vNearHXRange =
        v.pos >= h.start - cornerSnapToleranceCm && v.pos <= h.end + cornerSnapToleranceCm;
      if (vNearHXRange) {
        const dStart = Math.abs(v.start - h.pos);
        const dEnd = Math.abs(v.end - h.pos);
        if (dStart <= cornerSnapToleranceCm && dStart < dEnd && v.end - h.pos >= minSegLenCm) {
          v.start = h.pos;
        } else if (dEnd <= cornerSnapToleranceCm && dEnd < dStart && h.pos - v.start >= minSegLenCm) {
          v.end = h.pos;
        }
      }
    }
  }

  const minDanglingStubCm = pxToCm(8);
  const walls: Wall[] = [];
  let wallIdx = 1;

  for (const h of cleanH) {
    const len = h.end - h.start;
    if (len < minSegLenCm) continue;
    if (len < minDanglingStubCm && (!hTouchesV(h.pos, h.start) || !hTouchesV(h.pos, h.end))) {
      continue;
    }
    walls.push({
      id: `w_imp_${wallIdx++}`,
      start: { x: Math.round(h.start + ORIGIN_OFFSET_X), y: Math.round(h.pos + ORIGIN_OFFSET_Y) },
      end: { x: Math.round(h.end + ORIGIN_OFFSET_X), y: Math.round(h.pos + ORIGIN_OFFSET_Y) },
      thickness: h.thickness,
    });
  }

  for (const v of cleanV) {
    const len = v.end - v.start;
    if (len < minSegLenCm) continue;
    if (len < minDanglingStubCm && (!vTouchesH(v.pos, v.start) || !vTouchesH(v.pos, v.end))) {
      continue;
    }
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
 * Deterministic Raster-to-Vector Floorplan Parser:
 * 1. Thresholds image into raw binary mask.
 * 2. Connected-Component Analysis (CCA) strips all isolated letters, numbers, stove rings, and icons.
 * 3. Masks out OCR-detected text bounding boxes (without slicing into thick structural walls).
 * 4. Estimates dominant structural wall thickness and runs exact kernelSize x kernelSize morphological opening
 *    to strip thin 1-3px fixture outlines (toilets, sinks, bathtubs, counters, door swing arcs).
 * 5. Calibrates real-world scale from OCR dimensions via 4-way ray-casting and wing-wall detection.
 */
export function parseFloorplanImage(
  img: HTMLImageElement,
  options: ParseOptions,
  ocrCandidates: RawDimensionCandidate[] = [],
  useOcrScale = true,
  _roomCandidates: RawRoomNameCandidate[] = [],
  ocrTextBoxes: OcrTextBoxPx[] = []
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

  // Step 1: Connected-Component Filter — immediately strips isolated text characters ("KITCHEN", "STUDY"),
  // numbers ("9'3\" x 7'10\""), stove burner rings, compass rose, and standalone icons.
  const ccCleanedMask = filterConnectedComponents(
    rawMask,
    w,
    h,
    Math.max(24, Math.round(Math.max(w, h) * 0.04))
  );

  // Step 2: Erase remaining thin text pixels inside OCR-detected text bounding boxes,
  // while preserving thick structural wall runs (>= 5px thick in both axes) so oversized OCR boxes never clip walls
  for (const box of ocrTextBoxes) {
    const x0 = Math.max(0, box.x0 - 1);
    const y0 = Math.max(0, box.y0 - 1);
    const x1 = Math.min(w - 1, box.x1 + 1);
    const y1 = Math.min(h - 1, box.y1 + 1);
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        if (!ccCleanedMask[row + x]) continue;
        // Check if (x, y) is inside a 5x5 solid structural wall core
        let solidCore = true;
        for (let dy = -2; dy <= 2 && solidCore; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) {
            solidCore = false;
            break;
          }
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w || !rawMask[ny * w + nx]) {
              solidCore = false;
              break;
            }
          }
        }
        if (!solidCore) {
          ccCleanedMask[row + x] = 0;
        }
      }
    }
  }

  // Step 3: Optional double-line closing (only when structural walls are thin/hollow < 5px;
  // when walls are already solid >= 5px Poché, skipping prevents filling 1px gaps inside hollow door leaves)
  const preCloseThickPx = estimateStructuralWallThickness(ccCleanedMask, w, h);
  const closeGapPx = Math.max(3, options.minWallThicknessPx);
  const closedMask =
    options.closeHollowWalls && preCloseThickPx < 5
      ? closeDoubleLineGaps(ccCleanedMask, w, h, closeGapPx)
      : ccCleanedMask;

  // Step 4: Auto-adapt erosion kernel to structural wall thickness so thin 1-2px fixture lines
  // (toilets, sinks, bathtubs, counters, door arcs, closet shelves) attached to walls are stripped while walls survive
  const dominantWallThickPx = estimateStructuralWallThickness(closedMask, w, h);
  const autoKernelPx = Math.max(
    options.minWallThicknessPx,
    Math.min(5, Math.max(2, Math.round(dominantWallThickPx * 0.5)))
  );

  const openedMask = morphologicalOpen(closedMask, w, h, autoKernelPx);

  // Step 5: Second connected-component pass after opening to remove any small fixture stubs
  // that became detached when their thin outline strokes were eroded away
  const structuralMask = filterConnectedComponents(
    openedMask,
    w,
    h,
    Math.max(20, Math.round(Math.max(w, h) * 0.035))
  );

  // Step 6: Extract sub-pixel fine detail ridges (for anti-aliased 1px window lines and door arcs)
  // and multi-line window bands
  const { detailMask, winBandsPx } = extractFineDetailAndWindowBands(
    gray,
    rawMask,
    structuralMask,
    w,
    h,
    ocrTextBoxes
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

  const rawSegmentsPx = extractDirectionalWallSegments(
    structuralMask,
    w,
    h,
    Math.max(8, Math.round(options.minWallLengthCm / 3.5)),
    Math.max(3, autoKernelPx - 1),
    dominantWallThickPx
  );

  const ocrMatch = matchDimensionsToPixelWalls(
    ocrCandidates,
    [...rawSegmentsPx, ...winBandsPx],
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
  const cmPerPxX =
    useOcrScale && ocrMatch.cmPerPxX !== null
      ? ocrMatch.cmPerPxX
      : cmPerPx;
  const cmPerPxY =
    useOcrScale && ocrMatch.cmPerPxY !== null
      ? ocrMatch.cmPerPxY
      : cmPerPx;

  const segmentsCm: RawSegment[] = rawSegmentsPx.map((s) => ({
    axis: s.axis,
    pos: s.pos * (s.axis === 'h' ? cmPerPxY : cmPerPxX),
    start: s.start * (s.axis === 'h' ? cmPerPxX : cmPerPxY),
    end: s.end * (s.axis === 'h' ? cmPerPxX : cmPerPxY),
    thickness: Math.max(
      10,
      Math.min(25, Math.round(s.thickness * (s.axis === 'h' ? cmPerPxY : cmPerPxX)))
    ),
  }));

  const winBandsCm: RawSegment[] = winBandsPx.map((s) => ({
    axis: s.axis,
    pos: s.pos * (s.axis === 'h' ? cmPerPxY : cmPerPxX),
    start: s.start * (s.axis === 'h' ? cmPerPxX : cmPerPxY),
    end: s.end * (s.axis === 'h' ? cmPerPxX : cmPerPxY),
    thickness: Math.max(
      12,
      Math.min(20, Math.round(s.thickness * (s.axis === 'h' ? cmPerPxY : cmPerPxX)))
    ),
  }));

  const { walls, doors, windows } = regularizeFloorplanGraph(
    segmentsCm,
    detailMask,
    structuralMask,
    w,
    h,
    cmPerPx,
    options.minWallLengthCm,
    options.detectOpenings,
    winBandsCm,
    cmPerPxX,
    cmPerPxY
  );

  const detectedDimensions: DetectedDimension[] = ocrMatch.matched.map((d, idx) => ({
    ...d,
    xCm: Math.round(ocrCandidates[idx].cxPx * cmPerPxX + ORIGIN_OFFSET_X),
    yCm: Math.round(ocrCandidates[idx].cyPx * cmPerPxY + ORIGIN_OFFSET_Y),
  }));

  // Visual morphological mask preview (navy = kept structural walls, light gray = stripped text/toilets/sinks)
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
    roomLabels: [],
    maskPreviewDataUrl: previewCanvas.toDataURL('image/png'),
    computedThreshold,
    originOffset: { x: ORIGIN_OFFSET_X, y: ORIGIN_OFFSET_Y },
    boundsCm: {
      width: Math.round(w * cmPerPxX),
      height: Math.round(h * cmPerPxY),
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
