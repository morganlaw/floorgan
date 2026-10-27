import Tesseract from 'tesseract.js';
import type {
  Wall,
  Door,
  WindowItem,
  PlacedFurniture,
  FloorplanState,
  RoomLabel,
  Unit,
} from '../types';

export interface ParseOptions {
    threshold: number;
    minWallThicknessPx: number;
    minWallLengthCm: number;
    targetWidthMeters: number;
    closeHollowWalls: boolean;
    detectOpenings: boolean;
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
    xCm: number;
  yCm: number;
    matchedSpanPx?: { x1: number; y1: number; x2: number; y2: number };
    impliedCmPerPx?: number;
}

export interface RawDimensionCandidate {
  rawText: string;
  kind: 'pair' | 'single';
  unit: Unit;
  val1Cm: number;
  val2Cm?: number;
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

export interface RawSegment {
  axis: 'h' | 'v';
    pos: number;
    start: number;
    end: number;
    thickness: number;
}

export interface SegmentationMasks {
    width: number;
  height: number;
    structuralMask: Uint8Array;
    rawMask: Uint8Array;
    detailMask: Uint8Array;
    doorMask?: Uint8Array;
  windowMask?: Uint8Array;
    winBandsPx: RawSegment[];
    dominantWallThickPx: number;
    autoKernelPx: number;
    computedThreshold: number;
}

export const ORIGIN_OFFSET_X = 100;
export const ORIGIN_OFFSET_Y = 100;
export const MAX_PROC_DIM = 768;

/**
 * Automatically detects if an uploaded image is a dark blueprint / dark-mode plan
 * (white or colored CAD lines on a dark blue/black background).
 */
export function isDarkBlueprintImage(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number
): boolean {
  const step = Math.max(1, Math.floor((w * h) / 1000));
  let darkCount = 0;
  let totalSampled = 0;

  for (let i = 0; i < w * h; i += step) {
    const sOff = i * 4;
    const a = rgba[sOff + 3];
    if (a > 50) {
      const r = rgba[sOff];
      const g = rgba[sOff + 1];
      const b = rgba[sOff + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 95) darkCount++;
      totalSampled++;
    }
  }

  return totalSampled > 0 && darkCount / totalSampled > 0.60;
}

export interface HeuristicConfig {
    chromaThreshold: number;
  chromaMinLum: number;
    useLocalAdaptive: boolean;
  localRadius: number;
  localDelta: number;
  darkWallFloor: number;
    maxSolidBlobSpanPx: number;
    doubleLineRatioTrigger: number;
  doubleLineMaxGapPx: number;
    exteriorBlockerMaxDistPx: number;
    rejectWindowIfDoorSwing: boolean;
    requireDoorSwingForMlDoors: boolean;
}

export const DEFAULT_HEURISTIC_CONFIG: HeuristicConfig = {
  chromaThreshold: 25,
  chromaMinLum: 110,
  useLocalAdaptive: true,
  localRadius: 26,
  localDelta: 6,
  darkWallFloor: 90,
  maxSolidBlobSpanPx: 0,
  doubleLineRatioTrigger: 999,
  doubleLineMaxGapPx: 3,
  exteriorBlockerMaxDistPx: 550,
  rejectWindowIfDoorSwing: true,
  requireDoorSwingForMlDoors: true,
};

let activeHeuristicConfig: HeuristicConfig = { ...DEFAULT_HEURISTIC_CONFIG };

export function setHeuristicConfig(partial: Partial<HeuristicConfig>): void {
  activeHeuristicConfig = { ...DEFAULT_HEURISTIC_CONFIG, ...partial };
}

export function getHeuristicConfig(): HeuristicConfig {
  return activeHeuristicConfig;
}

function computeOtsuThreshold(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  const total = gray.length;
  let veryDarkCount = 0;
  for (let i = 0; i < total; i++) {
    const v = gray[i];
    hist[v]++;
    if (v < 70) veryDarkCount++;
  }

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

function estimateStructuralWallThickness(mask: Uint8Array, w: number, h: number): number {
  const runHist = new Int32Array(32);

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

function morphologicalOpen(
  mask: Uint8Array,
  w: number,
  h: number,
  kernelSize: number
): Uint8Array {
  if (kernelSize <= 1) return new Uint8Array(mask);
  const kLeft = Math.floor((kernelSize - 1) / 2);
  const kRight = kernelSize - 1 - kLeft;

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

    if (c.end > c.lastNormalEnd && c.end - c.lastNormalEnd <= maxWallThicknessPx) {
      c.end = c.lastNormalEnd + Math.min(halfT, c.end - c.lastNormalEnd);
    }

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

function parseImperialTokenToCm(
  rawDigits1: string,
  sep1: string | undefined,
  rawDigits2: string | undefined
): number | null {
  if (rawDigits2 !== undefined && rawDigits2 !== '') {
    const ft = parseInt(rawDigits1, 10);
    const inches = parseInt(rawDigits2, 10);
    if (ft >= 2 && ft <= 60 && inches >= 0 && inches < 12) {
      return Math.round((ft * 12 + inches) * 2.54);
    }
  }

  const n = parseInt(rawDigits1, 10);
  if (isNaN(n)) return null;

  if (n >= 3 && n <= 45 && (sep1 === "'" || !sep1)) {
    return Math.round(n * 12 * 2.54);
  }

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

function matchDimensionsToPixelWalls(
  candidates: RawDimensionCandidate[],
  rawSegmentsPx: RawSegment[],
  spanPxW: number,
  wallMask?: Uint8Array | null,
  maskWidth?: number,
  maskHeight?: number,
  ocrTextBoxes: OcrTextBoxPx[] = []
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

  const isInTextBox = (x: number, y: number): boolean => {
    for (const b of ocrTextBoxes) {
      if (x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.y0 - 2 && y <= b.y1 + 2) return true;
    }
    return false;
  };

  const findInnerFacesViaRays = (
    cx: number,
    cy: number,
    bMinX: number,
    bMaxX: number,
    bMinY: number,
    bMaxY: number
  ) => {
    if (!wallMask || !maskWidth || !maskHeight) return null;
    const leftHits: number[] = [];
    const rightHits: number[] = [];
    const topHits: number[] = [];
    const bottomHits: number[] = [];

    const ySteps = 9;
    for (let i = 1; i < ySteps; i++) {
      const y = Math.round(bMinY + (bMaxY - bMinY) * (i / ySteps));
      if (y < 0 || y >= maskHeight) continue;
      for (let x = Math.min(cx, maskWidth - 1); x >= Math.max(0, bMinX - 14); x--) {
        if (isInTextBox(x, y)) continue;
        if (wallMask[y * maskWidth + x] === 1) {
          leftHits.push(x + 1);
          break;
        }
      }
      for (let x = Math.max(cx, 0); x <= Math.min(maskWidth - 1, bMaxX + 14); x++) {
        if (isInTextBox(x, y)) continue;
        if (wallMask[y * maskWidth + x] === 1) {
          rightHits.push(x);
          break;
        }
      }
    }

    const xSteps = 9;
    for (let i = 1; i < xSteps; i++) {
      const x = Math.round(bMinX + (bMaxX - bMinX) * (i / xSteps));
      if (x < 0 || x >= maskWidth) continue;
      for (let y = Math.min(cy, maskHeight - 1); y >= Math.max(0, bMinY - 14); y--) {
        if (isInTextBox(x, y)) continue;
        if (wallMask[y * maskWidth + x] === 1) {
          topHits.push(y + 1);
          break;
        }
      }
      for (let y = Math.max(cy, 0); y <= Math.min(maskHeight - 1, bMaxY + 14); y++) {
        if (isInTextBox(x, y)) continue;
        if (wallMask[y * maskWidth + x] === 1) {
          bottomHits.push(y);
          break;
        }
      }
    }

    const median = (arr: number[]) => {
      if (arr.length === 0) return null;
      arr.sort((a, b) => a - b);
      return arr[Math.floor(arr.length / 2)];
    };

    return {
      rayLeft: median(leftHits),
      rayRight: median(rightHits),
      rayTop: median(topHits),
      rayBottom: median(bottomHits),
    };
  };

  const maxRayBridgeGapPx = Math.max(110, Math.round(spanPxW * 0.22));
  const bridgeWallGapsForRays = (segs: RawSegment[]): RawSegment[] => {
    const out = [...segs];
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i];
      if (a.end - a.start < 12) continue;
      for (let j = 0; j < segs.length; j++) {
        if (i === j) continue;
        const b = segs[j];
        if (b.end - b.start < 12) continue;
        if (
          Math.abs(a.pos - b.pos) <= 8 &&
          b.start > a.end &&
          b.start - a.end <= maxRayBridgeGapPx
        ) {
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

      const crossMarginPx = 12;

      let leftWall: RawSegment | null = null;
      let rightWall: RawSegment | null = null;

      for (const vw of vWalls) {
        if (vw.end - vw.start < 16) continue;
        if (cyPx >= vw.start - crossMarginPx && cyPx <= vw.end + crossMarginPx) {
          if (vw.pos < cxPx && (!leftWall || vw.pos > leftWall.pos)) {
            leftWall = vw;
          }
          if (vw.pos > cxPx && (!rightWall || vw.pos < rightWall.pos)) {
            rightWall = vw;
          }
        }
      }

      for (const hw of hWalls) {
        if (hw.end - hw.start < 16) continue;
        const inXRange =
          leftWall && rightWall
            ? Math.min(hw.end, rightWall.pos) - Math.max(hw.start, leftWall.pos) >= 16
            : cxPx >= hw.start - crossMarginPx && cxPx <= hw.end + crossMarginPx;
        if (inXRange) {
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

      // Room dimension labels denote the interior clear span (open area face-to-face),
      // completely excluding shaded black walls.
      const hThickAvg =
        topWall && bottomWall ? (topWall.thickness + bottomWall.thickness) / 2 : 0;
      const vThickAvg =
        leftWall && rightWall ? (leftWall.thickness + rightWall.thickness) / 2 : hThickAvg;

      const innerLeft =
        leftWall !== null
          ? leftWall.pos + leftWall.thickness / 2
          : leftX !== null
            ? leftX + (vThickAvg || hThickAvg)
            : null;
      const innerRight =
        rightWall !== null
          ? rightWall.pos - rightWall.thickness / 2
          : rightX !== null
            ? rightX - (vThickAvg || hThickAvg)
            : null;
      const innerTop =
        topWall !== null ? topWall.pos + topWall.thickness / 2 : null;
      const innerBottom =
        bottomWall !== null ? bottomWall.pos - bottomWall.thickness / 2 : null;

      const approxMinX = leftX ?? cxPx - 100;
      const approxMaxX = rightX ?? cxPx + 100;
      const approxMinY = topWall ? topWall.pos : cyPx - 100;
      const approxMaxY = bottomWall ? bottomWall.pos : cyPx + 100;

      const rayFaces = findInnerFacesViaRays(
        cxPx,
        cyPx,
        approxMinX,
        approxMaxX,
        approxMinY,
        approxMaxY
      );

      const finalInnerLeft = rayFaces?.rayLeft ?? innerLeft;
      const finalInnerRight = rayFaces?.rayRight ?? innerRight;
      const finalInnerTop = rayFaces?.rayTop ?? innerTop;
      const finalInnerBottom = rayFaces?.rayBottom ?? innerBottom;

      const roomW =
        finalInnerLeft !== null && finalInnerRight !== null ? Math.max(0, finalInnerRight - finalInnerLeft) : 0;
      const roomH =
        finalInnerTop !== null && finalInnerBottom !== null ? Math.max(0, finalInnerBottom - finalInnerTop) : 0;

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
          x1: finalInnerLeft!,
          y1: finalInnerTop!,
          x2: finalInnerRight!,
          y2: finalInnerBottom!,
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
        const rawLenPx = bestWall.end - bestWall.start;
        const lenPx =
          rawLenPx > bestWall.thickness * 4 ? rawLenPx - bestWall.thickness * 2 : rawLenPx;
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
      const w = r.areaPx / (0.005 + r.diff * r.diff);
      sumW += w;
      sumScale += r.scale * w;
      sumScaleX += r.scaleX * w;
      sumScaleY += r.scaleY * w;
    }
    medianCmPerPx = sumScale / sumW;
    cmPerPxX = sumScaleX / sumW;
    cmPerPxY = sumScaleY / sumW;

    if (Math.abs(cmPerPxX - cmPerPxY) / medianCmPerPx > 0.15) {
      cmPerPxX = medianCmPerPx;
      cmPerPxY = medianCmPerPx;
    }

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

let cachedOcrWorker: Tesseract.Worker | null = null;
let ocrWorkerPromise: Promise<Tesseract.Worker> | null = null;

async function getOcrWorker(): Promise<Tesseract.Worker> {
  if (cachedOcrWorker) return cachedOcrWorker;
  if (ocrWorkerPromise) return ocrWorkerPromise;

  ocrWorkerPromise = (async () => {
    const worker = await Tesseract.createWorker('eng');
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
    });
    cachedOcrWorker = worker;
    return worker;
  })();

  try {
    return await ocrWorkerPromise;
  } catch (err) {
    ocrWorkerPromise = null;
    throw err;
  }
}

export async function terminateOcrWorker(): Promise<void> {
  if (cachedOcrWorker) {
    const w = cachedOcrWorker;
    cachedOcrWorker = null;
    ocrWorkerPromise = null;
    try {
      await w.terminate();
    } catch {}
  }
}

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

  const worker = await getOcrWorker();
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
}

export function carveOpeningsFromWalls(
  walls: Wall[],
  openings: Array<{ x: number; y: number; width: number; rotation: number }>,
  minWallLengthCm = 20
): Wall[] {
  if (openings.length === 0 || walls.length === 0) return walls;
  const resultWalls: Wall[] = [];
  let nextId = 1;

  for (const w of walls) {
    const isH = Math.abs(w.end.x - w.start.x) >= Math.abs(w.end.y - w.start.y);
    const pos = isH ? Math.round((w.start.y + w.end.y) / 2) : Math.round((w.start.x + w.end.x) / 2);
    const wStart = isH ? Math.min(w.start.x, w.end.x) : Math.min(w.start.y, w.end.y);
    const wEnd = isH ? Math.max(w.start.x, w.end.x) : Math.max(w.start.y, w.end.y);
    const maxPerpTol = Math.max(w.thickness * 0.75, 18);

    const cuts: Array<{ start: number; end: number }> = [];
    for (const op of openings) {
      const opIsH = op.rotation % 180 === 0;
      if (opIsH !== isH) continue;
      const opPos = isH ? op.y : op.x;
      if (Math.abs(opPos - pos) > maxPerpTol) continue;

      const opCoord = isH ? op.x : op.y;
      const halfW = op.width / 2;
      const cStart = Math.max(wStart, Math.round(opCoord - halfW));
      const cEnd = Math.min(wEnd, Math.round(opCoord + halfW));
      if (cEnd > cStart) cuts.push({ start: cStart, end: cEnd });
    }

    if (cuts.length === 0) {
      resultWalls.push(w);
      continue;
    }

    cuts.sort((a, b) => a.start - b.start);
    const mergedCuts = [cuts[0]];
    for (let i = 1; i < cuts.length; i++) {
      const prev = mergedCuts[mergedCuts.length - 1];
      if (cuts[i].start <= prev.end) {
        prev.end = Math.max(prev.end, cuts[i].end);
      } else {
        mergedCuts.push(cuts[i]);
      }
    }

    let cur = wStart;
    for (const cut of mergedCuts) {
      if (cut.start - cur >= minWallLengthCm) {
        resultWalls.push({
          id: `w_imp_${nextId++}`,
          start: isH ? { x: cur, y: pos } : { x: pos, y: cur },
          end: isH ? { x: cut.start, y: pos } : { x: pos, y: cut.start },
          thickness: w.thickness,
        });
      }
      cur = Math.max(cur, cut.end);
    }
    if (wEnd - cur >= minWallLengthCm) {
      resultWalls.push({
        id: `w_imp_${nextId++}`,
        start: isH ? { x: cur, y: pos } : { x: pos, y: cur },
        end: isH ? { x: wEnd, y: pos } : { x: pos, y: wEnd },
        thickness: w.thickness,
      });
    }
  }

  return resultWalls;
}

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
  cmPerPxY: number = cmPerPx,
  mlDoorMask?: Uint8Array,
  mlWindowMask?: Uint8Array
): { walls: Wall[]; doors: Door[]; windows: WindowItem[] } {
  const useHeuristicOpenings =
    detectOpenings && !mlDoorMask && !mlWindowMask;
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
    const maxBlockerDist = pxToCm(activeHeuristicConfig.exteriorBlockerMaxDistPx);

    const hasPerpBridgeBetween = (perpAxis: 'h' | 'v', c1: number, c2: number): boolean => {
      if (activeHeuristicConfig.exteriorBlockerMaxDistPx >= 400) return true;
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

    if (activeHeuristicConfig.rejectWindowIfDoorSwing && span <= 58) {
      const swingDepth = Math.min(34, Math.max(16, Math.round(span * 0.75)));
      let posSwingCols = 0;
      let negSwingCols = 0;
      for (let t = pxStart + 2; t <= pxEnd - 2; t++) {
        let hasPos = false;
        let hasNeg = false;
        for (let d = 9; d <= swingDepth; d++) {
          const rxP = axis === 'h' ? t : pxPos + d;
          const ryP = axis === 'h' ? pxPos + d : t;
          if (rxP >= 0 && rxP < maskWidth && ryP >= 0 && ryP < maskHeight) {
            const idx = ryP * maskWidth + rxP;
            const isStruct = structuralMask ? structuralMask[idx] === 1 : false;
            if (!isStruct && rawBinaryMask[idx]) hasPos = true;
          }
          const rxN = axis === 'h' ? t : pxPos - d;
          const ryN = axis === 'h' ? pxPos - d : t;
          if (rxN >= 0 && rxN < maskWidth && ryN >= 0 && ryN < maskHeight) {
            const idx = ryN * maskWidth + rxN;
            const isStruct = structuralMask ? structuralMask[idx] === 1 : false;
            if (!isStruct && rawBinaryMask[idx]) hasNeg = true;
          }
        }
        if (hasPos) posSwingCols++;
        if (hasNeg) negSwingCols++;
      }
      const maxSwingCols = Math.max(posSwingCols, negSwingCols);
      if (maxSwingCols >= Math.max(8, Math.round(span * 0.35))) {
        return false;
      }
    }

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
   * Checks whether an ML door blob or wall gap actually contains drawn door
   * graphics (a swing arc/leaf outside the wall or a threshold/sliding panel
   * inside the opening) rather than being an empty open passage / archway.
   */
  function hasDoorGraphicInOpening(
    axis: 'h' | 'v',
    posCm: number,
    startCm: number,
    endCm: number,
    thicknessCm: number
  ): boolean {
    if (!rawBinaryMask || cmPerPx <= 0) return true;
    const posScale = axis === 'h' ? cmPerPxY : cmPerPxX;
    const spanScale = axis === 'h' ? cmPerPxX : cmPerPxY;
    const pxPos = Math.round(posCm / posScale);
    const pxStart = Math.round(Math.min(startCm, endCm) / spanScale);
    const pxEnd = Math.round(Math.max(startCm, endCm) / spanScale);
    const span = pxEnd - pxStart;
    if (span < 6) return false;

    // Step slightly inside the jambs so 1-2px of wall end-caps where the ML
    // door mask overlaps the wall aren't mistaken for door graphics.
    const pad = Math.min(4, Math.max(2, Math.floor(span * 0.12)));
    const t0 = pxStart + pad;
    const t1 = pxEnd - pad;
    if (t1 < t0) return true;

    const halfT = Math.max(2, Math.round(thicknessCm / posScale / 2));
    const searchDepth = Math.min(68, Math.max(14, Math.round(span * 1.05)));

    let interiorGapCols = 0;
    let swingZoneCols = 0;
    let totalThinPixels = 0;

    for (let t = t0; t <= t1; t++) {
      let colInGap = false;
      let colInSwing = false;
      for (let d = -searchDepth; d <= searchDepth; d++) {
        const rx = axis === 'h' ? t : pxPos + d;
        const ry = axis === 'h' ? pxPos + d : t;
        if (rx < 0 || rx >= maskWidth || ry < 0 || ry >= maskHeight) continue;
        const idx = ry * maskWidth + rx;
        const isStruct = structuralMask ? structuralMask[idx] === 1 : false;
        if (!isStruct && rawBinaryMask[idx] !== 0) {
          totalThinPixels++;
          if (Math.abs(d) <= halfT + 2) {
            colInGap = true;
          } else {
            colInSwing = true;
          }
        }
      }
      if (colInGap) interiorGapCols++;
      if (colInSwing) swingZoneCols++;
    }

    const interiorSpan = t1 - t0 + 1;
    const minCols = Math.max(3, Math.round(interiorSpan * 0.15));
    return (
      totalThinPixels >= 6 &&
      (swingZoneCols >= minCols || interiorGapCols >= minCols)
    );
  }

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

    function inferDoorSwingAndRotation(
    axis: 'h' | 'v',
    posCm: number,
    startCm: number,
    endCm: number
  ): { rotation: number; swingDirection: 'left' | 'right' } {
    if (!rawBinaryMask || cmPerPx <= 0) {
      return { rotation: axis === 'h' ? 0 : 90, swingDirection: 'left' };
    }
    const posScale = axis === 'h' ? cmPerPxY : cmPerPxX;
    const spanScale = axis === 'h' ? cmPerPxX : cmPerPxY;
    const pxPos = Math.round(posCm / posScale);
    const pxStart = Math.round(Math.min(startCm, endCm) / spanScale);
    const pxEnd = Math.round(Math.max(startCm, endCm) / spanScale);
    const span = Math.max(8, pxEnd - pxStart);

    let bestOpenSign: 1 | -1 = 1;
    let bestHingeAtStart = true;
    let bestScore = -1;

    for (const openSign of [1, -1] as const) {
      for (const hingeAtStart of [true, false]) {
        const tHinge = hingeAtStart ? pxStart : pxEnd;
        const dirT = hingeAtStart ? 1 : -1;

        let leafHits = 0;
        let leafTotal = 0;
        const rMin = Math.max(4, Math.round(span * 0.2));
        const rMax = Math.max(rMin + 2, Math.round(span * 0.9));
        for (let r = rMin; r <= rMax; r++) {
          leafTotal++;
          const d = openSign * r;
          let hit = false;
          for (let dt = -3; dt <= 3; dt++) {
            const t = tHinge + dt;
            const rx = axis === 'h' ? t : pxPos + d;
            const ry = axis === 'h' ? pxPos + d : t;
            if (rx >= 0 && rx < maskWidth && ry >= 0 && ry < maskHeight) {
              const idx = ry * maskWidth + rx;
              if (
                rawBinaryMask[idx] ||
                (structuralMask && structuralMask[idx] === 1)
              ) {
                hit = true;
                break;
              }
            }
          }
          if (hit) leafHits++;
        }

        let beyondHits = 0;
        let beyondTotal = 0;
        const bMin = Math.round(span * 1.15);
        const bMax = Math.max(bMin + 2, Math.round(span * 1.45));
        for (let r = bMin; r <= bMax; r++) {
          beyondTotal++;
          const d = openSign * r;
          let hit = false;
          for (let dt = -2; dt <= 2; dt++) {
            const t = tHinge + dt;
            const rx = axis === 'h' ? t : pxPos + d;
            const ry = axis === 'h' ? pxPos + d : t;
            if (rx >= 0 && rx < maskWidth && ry >= 0 && ry < maskHeight) {
              const idx = ry * maskWidth + rx;
              if (
                rawBinaryMask[idx] ||
                (structuralMask && structuralMask[idx] === 1)
              ) {
                hit = true;
                break;
              }
            }
          }
          if (hit) beyondHits++;
        }
        const rawLeafRatio = leafHits / Math.max(1, leafTotal);
        const beyondRatio = beyondHits / Math.max(1, beyondTotal);
        const leafScore = beyondRatio > 0.6 ? rawLeafRatio * 0.2 : rawLeafRatio;

        let arcHits = 0;
        let arcTotal = 0;
        for (let deg = 18; deg <= 72; deg += 4) {
          arcTotal++;
          const rad = (deg * Math.PI) / 180;
          let hit = false;
          for (let dr = -3; dr <= 3; dr++) {
            const r = span + dr;
            const t = Math.round(tHinge + dirT * r * Math.sin(rad));
            const d = Math.round(openSign * r * Math.cos(rad));
            const rx = axis === 'h' ? t : pxPos + d;
            const ry = axis === 'h' ? pxPos + d : t;
            if (rx >= 0 && rx < maskWidth && ry >= 0 && ry < maskHeight) {
              const idx = ry * maskWidth + rx;
              const isStruct = structuralMask ? structuralMask[idx] === 1 : false;
              if (!isStruct && rawBinaryMask[idx]) {
                hit = true;
                break;
              }
            }
          }
          if (hit) arcHits++;
        }
        const arcScore = arcHits / Math.max(1, arcTotal);

        const score = 1.0 * leafScore + 1.8 * arcScore;
        if (score > bestScore) {
          bestScore = score;
          bestOpenSign = openSign;
          bestHingeAtStart = hingeAtStart;
        }
      }
    }

    const opensPositive = bestOpenSign === 1;
    const hingeAtStart = bestHingeAtStart;

    if (axis === 'h') {
      if (opensPositive) {
        return {
          rotation: 0,
          swingDirection: hingeAtStart ? 'left' : 'right',
        };
      } else {
        return {
          rotation: 180,
          swingDirection: hingeAtStart ? 'right' : 'left',
        };
      }
    } else {
      if (!opensPositive) {
        return {
          rotation: 90,
          swingDirection: hingeAtStart ? 'left' : 'right',
        };
      } else {
        return {
          rotation: 270,
          swingDirection: hingeAtStart ? 'right' : 'left',
        };
      }
    }
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

    if (!useHeuristicOpenings || merged.length <= 1) {
      return merged.map((m) => ({
        axis,
        pos: Math.round(m.posWeight / m.totalLen),
        start: m.start,
        end: m.end,
        thickness: Math.min(30, Math.max(8, Math.round(m.thickWeight / m.totalLen))),
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
        30,
        Math.max(
          8,
          Math.round((prev.thickWeight + curr.thickWeight) / (prev.totalLen + curr.totalLen))
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
          const swing = inferDoorSwingAndRotation(axis, combinedPos, prev.end, curr.start);
          doors.push({
            id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
            x: axis === 'h' ? gapCenter + ORIGIN_OFFSET_X : combinedPos + ORIGIN_OFFSET_X,
            y: axis === 'h' ? combinedPos + ORIGIN_OFFSET_Y : gapCenter + ORIGIN_OFFSET_Y,
            width: formatDoorWidth(gapWidth),
            rotation: swing.rotation,
            swingDirection: swing.swingDirection,
          });
        }

        const opWidth = isWindowSpan ? formatWindowWidth(gapWidth) : formatDoorWidth(gapWidth);
        const halfOp = Math.round(opWidth / 2);
        prev.end = Math.min(prev.end, gapCenter - halfOp);
        curr.start = Math.max(curr.start, gapCenter + halfOp);
        bridged.push(curr);
      } else {
        bridged.push(curr);
      }
    }

    return bridged.map((m) => {
      const finalPos = Math.round(m.posWeight / m.totalLen);
      const finalThick = Math.min(30, Math.max(8, Math.round(m.thickWeight / m.totalLen)));
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

  if (useHeuristicOpenings) {
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
              const swing = inferDoorSwingAndRotation('v', v.pos, bestTopH.pos, v.start);
              doors.push({
                id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(v.pos + ORIGIN_OFFSET_X),
                y: Math.round(center + ORIGIN_OFFSET_Y),
                width: formatDoorWidth(bestTopGap),
                rotation: swing.rotation,
                swingDirection: swing.swingDirection,
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
              const swing = inferDoorSwingAndRotation('v', v.pos, v.end, bestBotH.pos);
              doors.push({
                id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(v.pos + ORIGIN_OFFSET_X),
                y: Math.round(center + ORIGIN_OFFSET_Y),
                width: formatDoorWidth(bestBotGap),
                rotation: swing.rotation,
                swingDirection: swing.swingDirection,
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
              const swing = inferDoorSwingAndRotation('h', h.pos, bestLeftV.pos, h.start);
              doors.push({
                id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(center + ORIGIN_OFFSET_X),
                y: Math.round(h.pos + ORIGIN_OFFSET_Y),
                width: formatDoorWidth(bestLeftGap),
                rotation: swing.rotation,
                swingDirection: swing.swingDirection,
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
              const swing = inferDoorSwingAndRotation('h', h.pos, h.end, bestRightV.pos);
              doors.push({
                id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                x: Math.round(center + ORIGIN_OFFSET_X),
                y: Math.round(h.pos + ORIGIN_OFFSET_Y),
                width: formatDoorWidth(bestRightGap),
                rotation: swing.rotation,
                swingDirection: swing.swingDirection,
              });
            }
            h.end = bestRightV.pos;
          }
        }
      }
    }

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
            const swing = inferDoorSwingAndRotation('h', y0, v1.pos, v2.pos);
            doors.push({
              id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
              x: Math.round(center + ORIGIN_OFFSET_X),
              y: Math.round(y0 + ORIGIN_OFFSET_Y),
              width: formatDoorWidth(gapX),
              rotation: swing.rotation,
              swingDirection: swing.swingDirection,
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
            const swing = inferDoorSwingAndRotation('v', x0, h1.pos, h2.pos);
            doors.push({
              id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
              x: Math.round(x0 + ORIGIN_OFFSET_X),
              y: Math.round(center + ORIGIN_OFFSET_Y),
              width: formatDoorWidth(gapY),
              rotation: swing.rotation,
              swingDirection: swing.swingDirection,
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
                const swing = inferDoorSwingAndRotation(axis, avgPos, a.end, b.start);
                doors.push({
                  id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
                  x: Math.round((axis === 'h' ? gapCenter : avgPos) + ORIGIN_OFFSET_X),
                  y: Math.round((axis === 'h' ? avgPos : gapCenter) + ORIGIN_OFFSET_Y),
                  width: formatDoorWidth(gapWidth),
                  rotation: swing.rotation,
                  swingDirection: swing.swingDirection,
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

  if (detectOpenings && (mlDoorMask || mlWindowMask)) {
    const extractComponentsFromMask = (
      mask: Uint8Array,
      minAreaPx = 10
    ): {
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      cxPx: number;
      cyPx: number;
      area: number;
    }[] => {
      const visited = new Uint8Array(maskWidth * maskHeight);
      const q = new Int32Array(maskWidth * maskHeight);
      const blobs: {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
        cxPx: number;
        cyPx: number;
        area: number;
      }[] = [];

      for (let y = 0; y < maskHeight; y++) {
        const rowOff = y * maskWidth;
        for (let x = 0; x < maskWidth; x++) {
          const startIdx = rowOff + x;
          if (!mask[startIdx] || visited[startIdx]) continue;

          visited[startIdx] = 1;
          let head = 0;
          let tail = 0;
          q[tail++] = startIdx;

          let minBx = x;
          let maxBx = x;
          let minBy = y;
          let maxBy = y;
          let sumX = 0;
          let sumY = 0;

          while (head < tail) {
            const curr = q[head++];
            const cy = Math.floor(curr / maskWidth);
            const cx = curr - cy * maskWidth;
            if (cx < minBx) minBx = cx;
            if (cx > maxBx) maxBx = cx;
            if (cy < minBy) minBy = cy;
            if (cy > maxBy) maxBy = cy;
            sumX += cx;
            sumY += cy;

            for (let dy = -1; dy <= 1; dy++) {
              const ny = cy + dy;
              if (ny < 0 || ny >= maskHeight) continue;
              const nRow = ny * maskWidth;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = cx + dx;
                if (nx < 0 || nx >= maskWidth) continue;
                const nIdx = nRow + nx;
                if (mask[nIdx] && !visited[nIdx]) {
                  visited[nIdx] = 1;
                  q[tail++] = nIdx;
                }
              }
            }
          }

          if (tail >= minAreaPx) {
            blobs.push({
              minX: minBx,
              maxX: maxBx,
              minY: minBy,
              maxY: maxBy,
              cxPx: sumX / tail,
              cyPx: sumY / tail,
              area: tail,
            });
          }
        }
      }
      return blobs;
    };

    const snapBlobToBestWall = (blob: {
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      cxPx: number;
      cyPx: number;
    }): {
      axis: 'h' | 'v';
      posCm: number;
      startCm: number;
      endCm: number;
      centerCm: number;
      widthCm: number;
      thicknessCm: number;
      wallId?: string;
    } | null => {
      const dxPx = blob.maxX - blob.minX + 1;
      const dyPx = blob.maxY - blob.minY + 1;
      if (Math.max(dxPx, dyPx) < 4) return null;

      const cxCm = blob.cxPx * cmPerPxX;
      const cyCm = blob.cyPx * cmPerPxY;
      const aspectPrefAxis: 'h' | 'v' | null =
        dxPx >= dyPx * 1.25 ? 'h' : dyPx >= dxPx * 1.25 ? 'v' : null;

      const maxPerpDistCm = Math.max(24, pxToCm(16));
      const endMarginCm = Math.max(20, pxToCm(14));

      let bestWall: Wall | null = null;
      let bestWallAxis: 'h' | 'v' = dxPx >= dyPx ? 'h' : 'v';
      let bestCost = Infinity;

      for (const w of walls) {
        const wx1 = w.start.x - ORIGIN_OFFSET_X;
        const wy1 = w.start.y - ORIGIN_OFFSET_Y;
        const wx2 = w.end.x - ORIGIN_OFFSET_X;
        const wy2 = w.end.y - ORIGIN_OFFSET_Y;
        const wAxis: 'h' | 'v' =
          Math.abs(wx2 - wx1) >= Math.abs(wy2 - wy1) ? 'h' : 'v';

        const wPos = wAxis === 'h' ? wy1 : wx1;
        const wStart = wAxis === 'h' ? Math.min(wx1, wx2) : Math.min(wy1, wy2);
        const wEnd = wAxis === 'h' ? Math.max(wx1, wx2) : Math.max(wy1, wy2);
        const blobPos = wAxis === 'h' ? cyCm : cxCm;
        const blobAlong = wAxis === 'h' ? cxCm : cyCm;

        const perpDist = Math.abs(blobPos - wPos);
        if (perpDist > maxPerpDistCm) continue;

        const alongDist =
          blobAlong < wStart
            ? wStart - blobAlong
            : blobAlong > wEnd
              ? blobAlong - wEnd
              : 0;
        if (alongDist > endMarginCm) continue;

        const axisPenalty =
          aspectPrefAxis && aspectPrefAxis !== wAxis ? pxToCm(8) : 0;
        const cost = perpDist + alongDist * 0.6 + axisPenalty;
        if (cost < bestCost) {
          bestCost = cost;
          bestWall = w;
          bestWallAxis = wAxis;
        }
      }

      const axis: 'h' | 'v' = bestWall
        ? bestWallAxis
        : dxPx >= dyPx
          ? 'h'
          : 'v';
      const posCm = bestWall
        ? axis === 'h'
          ? bestWall.start.y - ORIGIN_OFFSET_Y
          : bestWall.start.x - ORIGIN_OFFSET_X
        : Math.round(axis === 'h' ? cyCm : cxCm);
      const startCm = Math.round(
        axis === 'h' ? blob.minX * cmPerPxX : blob.minY * cmPerPxY
      );
      const endCm = Math.round(
        axis === 'h' ? (blob.maxX + 1) * cmPerPxX : (blob.maxY + 1) * cmPerPxY
      );
      const centerCm = Math.round((startCm + endCm) * 0.5);
      const widthCm = Math.max(25, endCm - startCm);
      const thicknessCm = bestWall ? bestWall.thickness : 15;

      return {
        axis,
        posCm,
        startCm,
        endCm,
        centerCm,
        widthCm,
        thicknessCm,
        wallId: bestWall?.id,
      };
    };

    const openPassages: Array<{
      x: number;
      y: number;
      width: number;
      rotation: number;
    }> = [];

    if (mlDoorMask) {
      const doorBlobs = extractComponentsFromMask(mlDoorMask, 8);
      for (const blob of doorBlobs) {
        const snapped = snapBlobToBestWall(blob);
        if (!snapped) continue;
        const xCm = Math.round(
          (snapped.axis === 'h' ? snapped.centerCm : snapped.posCm) +
            ORIGIN_OFFSET_X
        );
        const yCm = Math.round(
          (snapped.axis === 'h' ? snapped.posCm : snapped.centerCm) +
            ORIGIN_OFFSET_Y
        );
        // The segmentation model tends to label any wall gap between rooms as
        // a door. Without a drawn swing arc or door leaf/panel, the gap is an
        // open passage, so carve the wall opening without inserting a door.
        if (
          activeHeuristicConfig.requireDoorSwingForMlDoors &&
          !hasDoorGraphicInOpening(
            snapped.axis,
            snapped.posCm,
            snapped.startCm,
            snapped.endCm,
            snapped.thicknessCm
          )
        ) {
          openPassages.push({
            x: xCm,
            y: yCm,
            width: Math.max(30, Math.min(240, Math.round(snapped.widthCm))),
            rotation: snapped.axis === 'h' ? 0 : 90,
          });
          continue;
        }
        const swing = inferDoorSwingAndRotation(
          snapped.axis,
          snapped.posCm,
          snapped.startCm,
          snapped.endCm
        );
        const isDuplicate = doors.some(
          (d) => Math.hypot(d.x - xCm, d.y - yCm) <= pxToCm(8)
        );
        if (!isDuplicate) {
          doors.push({
            id: `door_imp_${doors.length + 1}_${Date.now().toString(36)}`,
            x: xCm,
            y: yCm,
            width: Math.max(30, Math.min(240, Math.round(snapped.widthCm))),
            rotation: swing.rotation,
            swingDirection: swing.swingDirection,
            wallId: snapped.wallId,
          });
        }
      }
    }

    if (mlWindowMask) {
      const winBlobs = extractComponentsFromMask(mlWindowMask, 8);
      for (const blob of winBlobs) {
        const snapped = snapBlobToBestWall(blob);
        if (!snapped) continue;
        const xCm = Math.round(
          (snapped.axis === 'h' ? snapped.centerCm : snapped.posCm) +
            ORIGIN_OFFSET_X
        );
        const yCm = Math.round(
          (snapped.axis === 'h' ? snapped.posCm : snapped.centerCm) +
            ORIGIN_OFFSET_Y
        );
        const isDuplicate = windows.some(
          (w) => Math.hypot(w.x - xCm, w.y - yCm) <= pxToCm(8)
        );
        if (!isDuplicate) {
          windows.push({
            id: `win_imp_${windows.length + 1}_${Date.now().toString(36)}`,
            x: xCm,
            y: yCm,
            width: Math.max(25, Math.min(500, Math.round(snapped.widthCm))),
            thickness: snapped.thicknessCm,
            rotation: snapped.axis === 'h' ? 0 : 90,
            wallId: snapped.wallId,
          });
        }
      }
    }

    if (openPassages.length > 0) {
      const carvedPassages = carveOpeningsFromWalls(walls, openPassages);
      walls.length = 0;
      walls.push(...carvedPassages);
    }
  }

  const cleanedWalls = carveOpeningsFromWalls(walls, [...doors, ...windows]);
  return { walls: cleanedWalls, doors, windows };
}

export function segmentFloorplanOtsu(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  options: ParseOptions,
  ocrTextBoxes: OcrTextBoxPx[] = []
): SegmentationMasks {
  const cfg = activeHeuristicConfig;
  const gray = new Uint8Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a < 50) {
      gray[i] = options.invert ? 0 : 255;
    } else {
      let lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      if (options.invert) lum = 255 - lum;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (
        cfg.chromaThreshold > 0 &&
        chroma > cfg.chromaThreshold &&
        lum > cfg.chromaMinLum
      ) {
        lum = Math.min(255, Math.round(lum + (chroma - cfg.chromaThreshold) * 3.2));
      }
      gray[i] = lum;
    }
  }

  const computedThreshold =
    options.threshold > 0 ? options.threshold : computeOtsuThreshold(gray);

  const rawMask = new Uint8Array(w * h);
  if (cfg.useLocalAdaptive && options.threshold === 0) {
    const stride = w + 1;
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      const srcRow = y * w;
      const dstRow = (y + 1) * stride;
      const prevRow = y * stride;
      for (let x = 0; x < w; x++) {
        rowSum += gray[srcRow + x];
        integral[dstRow + x + 1] = integral[prevRow + x + 1] + rowSum;
      }
    }

    const rad = cfg.localRadius;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - rad);
      const y1 = Math.min(h, y + rad + 1);
      const r0 = y0 * stride;
      const r1 = y1 * stride;
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const gVal = gray[rowOff + x];
        if (gVal >= computedThreshold) continue;
        if (gVal < cfg.darkWallFloor) {
          rawMask[rowOff + x] = 1;
        } else {
          const x0 = Math.max(0, x - rad);
          const x1 = Math.min(w, x + rad + 1);
          const count = (x1 - x0) * (y1 - y0);
          const sum =
            integral[r1 + x1] -
            integral[r0 + x1] -
            integral[r1 + x0] +
            integral[r0 + x0];
          const localMean = sum / count;
          if (gVal < localMean - cfg.localDelta) {
            rawMask[rowOff + x] = 1;
          }
        }
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) {
      rawMask[i] = gray[i] < computedThreshold ? 1 : 0;
    }
  }

  const ccCleanedMask = filterConnectedComponents(
    rawMask,
    w,
    h,
    Math.max(24, Math.round(Math.max(w, h) * 0.04))
  );

  if (cfg.maxSolidBlobSpanPx > 0) {
    const maxSpan = cfg.maxSolidBlobSpanPx;
    const hRunLen = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let x = 0;
      while (x < w) {
        if (!ccCleanedMask[row + x]) {
          x++;
          continue;
        }
        let endX = x + 1;
        while (endX < w && ccCleanedMask[row + endX]) endX++;
        const len = endX - x;
        for (let k = x; k < endX; k++) hRunLen[row + k] = len;
        x = endX;
      }
    }
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!ccCleanedMask[y * w + x]) {
          y++;
          continue;
        }
        let endY = y + 1;
        while (endY < h && ccCleanedMask[endY * w + x]) endY++;
        const vLen = endY - y;
        if (vLen > maxSpan) {
          for (let k = y; k < endY; k++) {
            const idx = k * w + x;
            if (hRunLen[idx] > maxSpan) {
              ccCleanedMask[idx] = 0;
            }
          }
        }
        y = endY;
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
        if (!ccCleanedMask[row + x]) continue;
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

  let thin13Runs = 0;
  let solid516Runs = 0;
  for (let y = 0; y < h; y += 2) {
    const row = y * w;
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (ccCleanedMask[row + x]) run++;
      else if (run > 0) {
        if (run <= 3) thin13Runs++;
        else if (run >= 5 && run <= 16) solid516Runs++;
        run = 0;
      }
    }
  }
  for (let x = 0; x < w; x += 2) {
    let run = 0;
    for (let y = 0; y < h; y++) {
      if (ccCleanedMask[y * w + x]) run++;
      else if (run > 0) {
        if (run <= 3) thin13Runs++;
        else if (run >= 5 && run <= 16) solid516Runs++;
        run = 0;
      }
    }
  }
  const thinToSolidRatio = thin13Runs / Math.max(1, solid516Runs);
  const isDoubleLinePlan = thinToSolidRatio >= cfg.doubleLineRatioTrigger;
  const preCloseThickPx = estimateStructuralWallThickness(ccCleanedMask, w, h);
  const closeGapPx = isDoubleLinePlan
    ? Math.max(cfg.doubleLineMaxGapPx, options.minWallThicknessPx)
    : Math.max(3, options.minWallThicknessPx);
  const closedMask =
    options.closeHollowWalls && (isDoubleLinePlan || preCloseThickPx < 5)
      ? closeDoubleLineGaps(ccCleanedMask, w, h, closeGapPx)
      : ccCleanedMask;

  const dominantWallThickPx = estimateStructuralWallThickness(closedMask, w, h);
  const autoKernelPx = Math.max(
    options.minWallThicknessPx,
    Math.min(5, Math.max(2, Math.round(dominantWallThickPx * 0.5)))
  );

  const openedMask = morphologicalOpen(closedMask, w, h, autoKernelPx);

  const structuralMask = filterConnectedComponents(
    openedMask,
    w,
    h,
    Math.max(20, Math.round(Math.max(w, h) * 0.035))
  );

  const { detailMask, winBandsPx } = extractFineDetailAndWindowBands(
    gray,
    rawMask,
    structuralMask,
    w,
    h,
    ocrTextBoxes
  );

  return {
    width: w,
    height: h,
    structuralMask,
    rawMask,
    detailMask,
    winBandsPx,
    dominantWallThickPx,
    autoKernelPx,
    computedThreshold,
  };
}

export function parseFloorplanRgbaBuffer(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  options: ParseOptions,
  ocrCandidates: RawDimensionCandidate[] = [],
  useOcrScale = true,
  _roomCandidates: RawRoomNameCandidate[] = [],
  ocrTextBoxes: OcrTextBoxPx[] = [],
  customMasks?: SegmentationMasks
): ParseResult & { masks: SegmentationMasks } {
  const masks =
    customMasks ?? segmentFloorplanOtsu(rgba, w, h, options, ocrTextBoxes);

  const {
    structuralMask,
    detailMask,
    winBandsPx,
    dominantWallThickPx,
    autoKernelPx,
    computedThreshold,
  } = masks;

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

  const wallTraceMask = structuralMask;

  const rawSegmentsPx = extractDirectionalWallSegments(
    wallTraceMask,
    w,
    h,
    Math.max(8, Math.round(options.minWallLengthCm / 3.5)),
    Math.max(3, autoKernelPx - 1),
    dominantWallThickPx
  );

  const ocrMatch = matchDimensionsToPixelWalls(
    ocrCandidates,
    [...rawSegmentsPx, ...winBandsPx],
    spanPxW,
    masks.rawMask || masks.structuralMask,
    w,
    h,
    ocrTextBoxes
  );

  let doorCalibratedCmPerPx: number | null = null;
  let doorCalibratedWidthMeters: number | null = null;
  if (ocrMatch.cmPerPx === null && masks.doorMask) {
    const dm = masks.doorMask;
    const visited = new Uint8Array(w * h);
    const q = new Int32Array(w * h);
    const doorSpansPx: number[] = [];

    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const sIdx = rowOff + x;
        if (!dm[sIdx] || visited[sIdx]) continue;
        visited[sIdx] = 1;
        let head = 0;
        let tail = 0;
        q[tail++] = sIdx;
        let minBx = x;
        let maxBx = x;
        let minBy = y;
        let maxBy = y;
        while (head < tail) {
          const curr = q[head++];
          const cy = Math.floor(curr / w);
          const cx = curr - cy * w;
          if (cx < minBx) minBx = cx;
          if (cx > maxBx) maxBx = cx;
          if (cy < minBy) minBy = cy;
          if (cy > maxBy) maxBy = cy;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny < 0 || ny >= h) continue;
            const nRow = ny * w;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx < 0 || nx >= w) continue;
              const nIdx = nRow + nx;
              if (dm[nIdx] && !visited[nIdx]) {
                visited[nIdx] = 1;
                q[tail++] = nIdx;
              }
            }
          }
        }
        if (tail >= 10) {
          const spanPx = Math.max(maxBx - minBx + 1, maxBy - minBy + 1);
          if (spanPx >= 12 && spanPx <= 95) {
            doorSpansPx.push(spanPx);
          }
        }
      }
    }

    if (doorSpansPx.length > 0) {
      doorSpansPx.sort((a, b) => a - b);
      const refDoorPx = doorSpansPx[Math.floor(doorSpansPx.length * 0.4)];
      const impliedCmPerPx = 82 / refDoorPx;
      const impliedWidthM = (spanPxW * impliedCmPerPx) / 100;
      if (impliedWidthM >= 3.5 && impliedWidthM <= 45) {
        doorCalibratedCmPerPx = impliedCmPerPx;
        doorCalibratedWidthMeters = Math.round(impliedWidthM * 10) / 10;
      }
    }
  }

  const autoCalibratedWidthMeters =
    ocrMatch.calibratedWidthMeters ?? doorCalibratedWidthMeters;

  const effectiveWidthMeters =
    useOcrScale && autoCalibratedWidthMeters !== null
      ? autoCalibratedWidthMeters
      : options.targetWidthMeters;

  const targetWidthCm = Math.max(200, effectiveWidthMeters * 100);
  const cmPerPx =
    useOcrScale && ocrMatch.cmPerPx !== null
      ? ocrMatch.cmPerPx
      : useOcrScale && doorCalibratedCmPerPx !== null
        ? doorCalibratedCmPerPx
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
      8,
      Math.min(30, Math.round(s.thickness * (s.axis === 'h' ? cmPerPxY : cmPerPxX)))
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
    cmPerPxY,
    masks.doorMask,
    masks.windowMask
  );

  const detectedDimensions: DetectedDimension[] = ocrMatch.matched.map((d, idx) => ({
    ...d,
    xCm: Math.round(ocrCandidates[idx].cxPx * cmPerPxX + ORIGIN_OFFSET_X),
    yCm: Math.round(ocrCandidates[idx].cyPx * cmPerPxY + ORIGIN_OFFSET_Y),
  }));

  return {
    walls,
    doors,
    windows,
    furniture: [],
    roomLabels: [],
    maskPreviewDataUrl: '',
    computedThreshold,
    originOffset: { x: ORIGIN_OFFSET_X, y: ORIGIN_OFFSET_Y },
    boundsCm: {
      width: Math.round(w * cmPerPxX),
      height: Math.round(h * cmPerPxY),
    },
    detectedDimensions,
    autoCalibratedWidthMeters,
    detectedUnit: ocrMatch.detectedUnit,
    masks,
  };
}

export function parseFloorplanImage(
  img: HTMLImageElement,
  options: ParseOptions,
  ocrCandidates: RawDimensionCandidate[] = [],
  useOcrScale = true,
  roomCandidates: RawRoomNameCandidate[] = [],
  ocrTextBoxes: OcrTextBoxPx[] = [],
  customMasks?: SegmentationMasks
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
  const result = parseFloorplanRgbaBuffer(
    imgData.data,
    w,
    h,
    options,
    ocrCandidates,
    useOcrScale,
    roomCandidates,
    ocrTextBoxes,
    customMasks
  );

  const { structuralMask, rawMask, doorMask, windowMask } = result.masks;

  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = w;
  previewCanvas.height = h;
  const pCtx = previewCanvas.getContext('2d')!;
  const pData = pCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const isDoor = doorMask ? doorMask[i] === 1 : false;
    const isWin = windowMask ? windowMask[i] === 1 : false;
    const isWall = structuralMask[i] === 1;
    const isRaw = rawMask[i] === 1;
    if (isDoor) {
      pData.data[i * 4] = 5;
      pData.data[i * 4 + 1] = 150;
      pData.data[i * 4 + 2] = 105;
      pData.data[i * 4 + 3] = 255;
    } else if (isWin) {
      pData.data[i * 4] = 2;
      pData.data[i * 4 + 1] = 132;
      pData.data[i * 4 + 2] = 199;
      pData.data[i * 4 + 3] = 255;
    } else if (isWall) {
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
    ...result,
    maskPreviewDataUrl: previewCanvas.toDataURL('image/png'),
  };
}

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

  try {
    const directImageDataUrl = await fetchImageUrlAsDataUrl(normalizedUrl);
    if (directImageDataUrl) {
      return { primaryDataUrl: directImageDataUrl, candidates: [] };
    }
  } catch {
  }

  const htmlFetchers: (() => Promise<string>)[] = [
    async () => {
      const r = await fetch(
        `https://api.allorigins.win/get?url=${encodeURIComponent(normalizedUrl)}`
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      return json?.contents || '';
    },
    async () => {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(normalizedUrl)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    },
  ];

  let lastError: Error | null = null;

  for (const fetchHtml of htmlFetchers) {
    try {
      const html = await fetchHtml();
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
    (u: string) => `https://wsrv.nl/?url=${encodeURIComponent(u)}&output=png`,
    (u: string) => `https://wsrv.nl/?url=${encodeURIComponent(u)}`,
    (u: string) => u,
  ];

  for (const makeProxy of proxies) {
    try {
      const resp = await fetch(makeProxy(imageUrl));
      if (!resp.ok) continue;
      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) {
        continue;
      }
      const blob = await resp.blob();
      if (blob.size > 100) {
        return await blobToDataUrl(blob);
      }
    } catch {
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

export function createSampleBlueprintDataUrl(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 620;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

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

  ctx.fillStyle = '#0f172a';

  ctx.fillRect(60, 60, 160, 12);
  ctx.fillRect(320, 60, 220, 12);
  ctx.fillRect(640, 60, 100, 12);

  ctx.fillRect(60, 540, 120, 12);
  ctx.fillRect(245, 540, 495, 12);

  ctx.fillRect(60, 60, 12, 492);

  ctx.fillRect(728, 60, 12, 160);
  ctx.fillRect(728, 330, 12, 222);

  ctx.fillRect(450, 60, 9, 280);
  ctx.fillRect(450, 405, 9, 147);

  ctx.fillRect(60, 290, 200, 9);
  ctx.fillRect(320, 290, 135, 9);

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.strokeRect(220, 62, 100, 8);
  ctx.strokeRect(540, 62, 100, 8);
  ctx.strokeRect(730, 220, 8, 110);

  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(180, 540, 65, -Math.PI / 2, 0);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(455, 340, 65, 0, Math.PI / 2);
  ctx.stroke();

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
