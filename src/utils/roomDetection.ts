import type { Door, TextBoxItem, Unit, Wall, WindowItem } from '../types';

/** A room found between the parsed walls, in plan coordinates (cm). */
export interface DetectedRoom {
  id: string;
  /** Room name read by OCR inside the room, if any */
  name: string | null;
  /** Label anchor (cm) */
  cx: number;
  cy: number;
  /** Interior extents, wall face to wall face, along x and y (cm) */
  widthCm: number;
  depthCm: number;
  areaCm2: number;
  /** True when the room fills most of its bounding box, so width × depth describes it */
  rectangular: boolean;
  /** Interior bounding box in processing pixels (for evaluation) */
  bboxPx: { x0: number; y0: number; x1: number; y1: number };
}

export interface RoomNameHint {
  name: string;
  cxPx: number;
  cyPx: number;
}

export interface DetectRoomsInput {
  walls: Wall[];
  doors: Door[];
  windows: WindowItem[];
  /** Processing raster size the plan was parsed at */
  w: number;
  h: number;
  cmPerPxX: number;
  cmPerPxY: number;
  origin: { x: number; y: number };
  roomNames?: RoomNameHint[];
  /** Doorless openings the parser carved into walls; treated as closed like doors */
  passages?: { x: number; y: number; width: number; rotation: number }[];
  /** Gap size (cm) sealed when finding room cores; rooms narrower than ~2x this are not found */
  closingCm?: number;
  minAreaM2?: number;
  minSideCm?: number;
}

const DOOR_BARRIER_CM = 20;

/**
 * Rooms are the enclosed free-space regions between walls, with doors and windows treated as closed.
 * Walls, doors and windows are rasterised onto the processing grid (slightly dilated to close hairline gaps
 * at corners), free space is flood-filled, and regions touching the image border are outside.
 */
export function detectRooms(input: DetectRoomsInput): DetectedRoom[] {
  const { walls, doors, windows, w, h, cmPerPxX, cmPerPxY, origin } = input;
  if (w <= 0 || h <= 0 || !(cmPerPxX > 0) || !(cmPerPxY > 0) || walls.length < 3) return [];
  const minAreaCm2 = (input.minAreaM2 ?? 1.5) * 10000;
  const minSideCm = input.minSideCm ?? 80;
  const cmPerPx = (cmPerPxX + cmPerPxY) / 2;
  // Closing radius: ~6 cm, at least 1 px. Interior extents are corrected for it below.
  const r = Math.max(1, Math.round(6 / cmPerPx));

  const barrier = new Uint8Array(w * h);
  const toPx = (x: number) => (x - origin.x) / cmPerPxX;
  const toPy = (y: number) => (y - origin.y) / cmPerPxY;

  const drawSegment = (x1: number, y1: number, x2: number, y2: number, halfThickPx: number) => {
    const rad = halfThickPx + r;
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - rad));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(x1, x2) + rad));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - rad));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(y1, y2) + rad));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const rad2 = rad * rad;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = x1 + t * dx - px;
        const ey = y1 + t * dy - py;
        if (ex * ex + ey * ey <= rad2) barrier[y * w + x] = 1;
      }
    }
  };

  for (const wall of walls) {
    drawSegment(toPx(wall.start.x), toPy(wall.start.y), toPx(wall.end.x), toPy(wall.end.y), wall.thickness / cmPerPx / 2);
  }
  const drawOpening = (o: { x: number; y: number; width: number; rotation: number }, thickCm: number) => {
    const a = (o.rotation * Math.PI) / 180;
    const hx = (Math.cos(a) * o.width) / 2;
    const hy = (Math.sin(a) * o.width) / 2;
    drawSegment(toPx(o.x - hx), toPy(o.y - hy), toPx(o.x + hx), toPy(o.y + hy), thickCm / cmPerPx / 2);
  };
  for (const d of doors) drawOpening(d, DOOR_BARRIER_CM);
  for (const win of windows) drawOpening(win, Math.max(DOOR_BARRIER_CM, win.thickness || 0));
  for (const pg of input.passages ?? []) drawOpening(pg, DOOR_BARRIER_CM);

  // Two scales. Room cores are found with every barrier thickened by R (~closingCm), which seals small gaps
  // in walls the model broke and stops a room leaking to the outside or into its neighbour; each core is then
  // grown back (up to R + 2 px) through the real free space to recover the room's true extent.
  const R = Math.max(2, Math.round((input.closingCm ?? 35) / cmPerPx));
  const INF = 1 << 29;
  const dist = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = barrier[i] ? 0 : INF;
  // 3-4 chamfer distance transform (units of 1/3 px)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 3);
      if (y > 0) {
        d = Math.min(d, dist[i - w] + 3);
        if (x > 0) d = Math.min(d, dist[i - w - 1] + 4);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1] + 4);
      }
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = dist[i];
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 3);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w] + 3);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1] + 4);
        if (x > 0) d = Math.min(d, dist[i + w - 1] + 4);
      }
      dist[i] = d;
    }
  }
  const core = (i: number) => dist[i] > 3 * R;

  // Label cores (4-connected); cores touching the image border are outside.
  const label = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  const coreIsRoom: boolean[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!core(start) || label[start] !== -1) continue;
    const id = coreIsRoom.length;
    let border = false;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const p = queue[head++];
      const y = (p / w) | 0;
      const x = p - y * w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && core(p - 1) && label[p - 1] === -1) (label[p - 1] = id), (queue[tail++] = p - 1);
      if (x < w - 1 && core(p + 1) && label[p + 1] === -1) (label[p + 1] = id), (queue[tail++] = p + 1);
      if (y > 0 && core(p - w) && label[p - w] === -1) (label[p - w] = id), (queue[tail++] = p - w);
      if (y < h - 1 && core(p + w) && label[p + w] === -1) (label[p + w] = id), (queue[tail++] = p + w);
    }
    coreIsRoom.push(!border);
  }

  // Grow room cores back through free (non-barrier) space, breadth-first, at most R + 2 steps.
  const steps = new Int32Array(w * h).fill(-1);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < w * h; i++) {
    if (label[i] >= 0) {
      if (coreIsRoom[label[i]]) {
        steps[i] = 0;
        queue[tail++] = i;
      } else {
        label[i] = -1;
      }
    }
  }
  while (head < tail) {
    const p = queue[head++];
    if (steps[p] >= R + 2) continue;
    const y = (p / w) | 0;
    const x = p - y * w;
    const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const q of nbrs) {
      if (q < 0 || barrier[q] || label[q] !== -1) continue;
      label[q] = label[p];
      steps[q] = steps[p] + 1;
      queue[tail++] = q;
    }
  }

  interface Comp {
    count: number;
    rows: Map<number, number>;
    cols: Map<number, number>;
    sx: number;
    sy: number;
  }
  const comps = new Map<number, Comp>();
  for (let i = 0; i < w * h; i++) {
    const id = label[i];
    if (id < 0) continue;
    let c = comps.get(id);
    if (!c) comps.set(id, (c = { count: 0, rows: new Map(), cols: new Map(), sx: 0, sy: 0 }));
    const y = (i / w) | 0;
    const x = i - y * w;
    c.count++;
    c.sx += x;
    c.sy += y;
    c.rows.set(y, (c.rows.get(y) ?? 0) + 1);
    c.cols.set(x, (c.cols.get(x) ?? 0) + 1);
  }

  const rooms: DetectedRoom[] = [];
  comps.forEach((c, id) => {
    if (c.count === 0) return;
    // Extents from rows/columns holding >= 30% of the widest row/column, so a thin spill through a gap in a wall
    // (at most R px long) doesn't stretch the room.
    const span = (m: Map<number, number>) => {
      const maxV = Math.max(...m.values());
      const keys = [...m.entries()].filter(([, v]) => v >= 0.3 * maxV).map(([k]) => k);
      return [Math.min(...keys), Math.max(...keys)];
    };
    const [x0, x1] = span(c.cols);
    const [y0, y1] = span(c.rows);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    // The barrier dilation ate r px from every face; add it back to get wall-face to wall-face extents.
    const widthCm = (bw + 2 * r) * cmPerPxX;
    const depthCm = (bh + 2 * r) * cmPerPxY;
    let inBox = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (label[y * w + x] === id) inBox++;
    const fill = inBox / (bw * bh);
    const areaCm2 = fill * widthCm * depthCm;
    if (areaCm2 < minAreaCm2 || Math.min(widthCm, depthCm) < minSideCm) return;

    // Label anchor: centroid, or the room pixel nearest to it for L-shaped rooms.
    let ax = Math.round(c.sx / c.count);
    let ay = Math.round(c.sy / c.count);
    if (label[ay * w + ax] !== id) {
      let best = Infinity;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (label[y * w + x] !== id) continue;
          const d = (x - ax) ** 2 + (y - ay) ** 2;
          if (d < best) {
            best = d;
            ax = x;
            ay = y;
          }
        }
      }
    }

    let name: string | null = null;
    for (const hint of input.roomNames ?? []) {
      const hx = Math.round(hint.cxPx);
      const hy = Math.round(hint.cyPx);
      if (hx >= 0 && hy >= 0 && hx < w && hy < h && label[hy * w + hx] === id) {
        name = hint.name;
        break;
      }
    }

    rooms.push({
      id: `room_${rooms.length + 1}`,
      name,
      cx: Math.round(origin.x + (ax + 0.5) * cmPerPxX),
      cy: Math.round(origin.y + (ay + 0.5) * cmPerPxY),
      widthCm: Math.round(widthCm),
      depthCm: Math.round(depthCm),
      areaCm2: Math.round(areaCm2),
      rectangular: fill >= 0.85,
      bboxPx: { x0: x0 - r, y0: y0 - r, x1: x1 + 1 + r, y1: y1 + 1 + r },
    });
  });
  rooms.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  rooms.forEach((room, i) => (room.id = `room_${i + 1}`));
  return rooms;
}

function formatLength(cm: number, unit: Unit): string {
  if (unit === 'ft') {
    const totalIn = Math.round(cm / 2.54);
    return `${Math.floor(totalIn / 12)}'${totalIn % 12}"`;
  }
  return (cm / 100).toFixed(1);
}

/** Text for a room label: name (if known) and size in the plan's unit. */
export function formatRoomLabelText(
  room: { name: string | null; widthCm: number; depthCm: number; areaCm2: number; rectangular: boolean },
  unit: Unit
): string {
  let size: string;
  if (room.rectangular) {
    size =
      unit === 'ft'
        ? `${formatLength(room.widthCm, unit)} × ${formatLength(room.depthCm, unit)}`
        : `${formatLength(room.widthCm, unit)} × ${formatLength(room.depthCm, unit)} m`;
  } else {
    size = unit === 'ft' ? `${Math.round(room.areaCm2 / 929.03)} ft²` : `${(room.areaCm2 / 10000).toFixed(1)} m²`;
  }
  return room.name ? `${room.name}\n${size}` : size;
}

/** A borderless, transparent text box labelling a detected room. */
export function roomLabelTextBox(room: DetectedRoom, unit: Unit): TextBoxItem {
  const meta = {
    name: room.name,
    widthCm: room.widthCm,
    depthCm: room.depthCm,
    areaCm2: room.areaCm2,
    rectangular: room.rectangular,
  };
  const text = formatRoomLabelText(meta, unit);
  const lines = text.split('\n');
  const fontSize = 30;
  const width = Math.max(110, Math.max(...lines.map((l) => l.length)) * fontSize * 0.62 + 24);
  return {
    id: `text_${room.id}_${Date.now().toString(36)}`,
    text,
    x: room.cx,
    y: room.cy,
    width: Math.round(width),
    height: Math.round(lines.length * fontSize * 1.3 + 12),
    fontSize,
    color: '#334155',
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    borderStyle: 'none',
    borderRadius: 0,
    rotation: 0,
    textAlign: 'center',
    bold: false,
    italic: false,
    room: meta,
  };
}

/**
 * Keep generated room labels in sync after a scale or unit change. Labels the user has edited (text no longer
 * matches what was generated) lose their room link and are left alone.
 */
export function refreshRoomLabels(
  textBoxes: TextBoxItem[] | undefined,
  prevUnit: Unit,
  nextUnit: Unit,
  scaleFactor = 1
): TextBoxItem[] | undefined {
  if (!textBoxes) return textBoxes;
  return textBoxes.map((t) => {
    if (!t.room) return t;
    if (t.text !== formatRoomLabelText(t.room, prevUnit)) {
      const { room: _drop, ...plain } = t;
      return plain;
    }
    const room = {
      ...t.room,
      widthCm: Math.round(t.room.widthCm * scaleFactor),
      depthCm: Math.round(t.room.depthCm * scaleFactor),
      areaCm2: Math.round(t.room.areaCm2 * scaleFactor * scaleFactor),
    };
    return { ...t, room, text: formatRoomLabelText(room, nextUnit) };
  });
}
