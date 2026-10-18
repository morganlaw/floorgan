import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Undo2, Trash2, Magnet, Check, Shapes, PenTool, Lock, Unlock, Plus } from 'lucide-react';
import { FurnitureCatalogItem, Point, Unit } from '../types';
import {
  BASIC_SHAPES,
  BasicShapeKind,
  getNormalizedShapePoints,
  normalizePolygon,
} from '../utils/shapes';
import { formatDimension, distance, snapAngle } from '../utils/geometry';
import { ShapeBody, ShapeThumbnail } from './ShapeBody';

interface Props {
  isOpen: boolean;
  unit: Unit;
  /** When set, the creator edits this existing custom catalog item */
  editingItem: FurnitureCatalogItem | null;
  onClose: () => void;
  onSave: (item: FurnitureCatalogItem, placeNow: boolean) => void;
}

type Mode = 'basic' | 'advanced';

const COLORS = [
  '#334155',
  '#475569',
  '#6366f1',
  '#0284c7',
  '#0f766e',
  '#15803d',
  '#b45309',
  '#78350f',
  '#dc2626',
];

const WORKSPACES = [
  { w: 200, h: 150 },
  { w: 400, h: 300 },
  { w: 800, h: 600 },
];

const MIN_SIZE = 5; // cm

const cmToUnit = (cm: number, unit: Unit) => (unit === 'm' ? cm / 100 : cm / 30.48);
const unitToCm = (v: number, unit: Unit) => (unit === 'm' ? v * 100 : v * 30.48);

const toSvgPoint = (svg: SVGSVGElement, clientX: number, clientY: number): Point => {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
};

const polygonArea = (pts: Point[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

const formatArea = (cm2: number, unit: Unit) =>
  unit === 'm' ? `${(cm2 / 10000).toFixed(2)} m²` : `${(cm2 / 929.0304).toFixed(1)} ft²`;

/** Unit-aware numeric input that allows smooth typing and commits valid values in cm. */
const DimInput: React.FC<{
  label: string;
  valueCm: number;
  unit: Unit;
  onChange: (cm: number) => void;
}> = ({ label, valueCm, unit, onChange }) => {
  const [draft, setDraft] = useState<string | null>(null);

  const displayVal = cmToUnit(valueCm, unit);
  const formattedVal = displayVal.toFixed(2);

  const commitValue = (raw: string) => {
    const clean = raw.trim().replace(',', '.');
    const v = parseFloat(clean);
    if (!isNaN(v) && v > 0) {
      const cm = unitToCm(v, unit);
      onChange(Math.max(MIN_SIZE, Math.round(cm * 10) / 10));
    }
    setDraft(null);
  };

  return (
    <div className="field-group flex-1">
      <label className="field-label">
        {label} ({unit})
      </label>
      <input
        type="text"
        inputMode="decimal"
        className="field-input"
        value={draft !== null ? draft : formattedVal}
        onFocus={() => {
          setDraft(formattedVal);
        }}
        onChange={(e) => {
          const val = e.target.value;
          setDraft(val);
          const clean = val.trim().replace(',', '.');
          const v = parseFloat(clean);
          if (!isNaN(v) && v > 0 && !val.endsWith('.') && !val.endsWith(',')) {
            const cm = unitToCm(v, unit);
            onChange(Math.max(MIN_SIZE, Math.round(cm * 10) / 10));
          }
        }}
        onBlur={(e) => {
          commitValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitValue(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const step = unit === 'm' ? 0.05 : 0.25;
            const current = parseFloat((draft ?? formattedVal).replace(',', '.')) || displayVal;
            const next = current + step;
            const cm = unitToCm(next, unit);
            onChange(Math.max(MIN_SIZE, Math.round(cm * 10) / 10));
            setDraft(next.toFixed(2));
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const step = unit === 'm' ? 0.05 : 0.25;
            const current = parseFloat((draft ?? formattedVal).replace(',', '.')) || displayVal;
            const next = Math.max(cmToUnit(MIN_SIZE, unit), current - step);
            const cm = unitToCm(next, unit);
            onChange(Math.max(MIN_SIZE, Math.round(cm * 10) / 10));
            setDraft(next.toFixed(2));
          }
        }}
      />
    </div>
  );
};

export const CustomObjectCreator: React.FC<Props> = ({
  isOpen,
  unit,
  editingItem,
  onClose,
  onSave,
}) => {
  const [mode, setMode] = useState<Mode>('basic');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#0f766e');

  // Basic mode
  const [shape, setShape] = useState<BasicShapeKind>('rect');
  const [width, setWidth] = useState(100);
  const [depth, setDepth] = useState(60);
  const [lockAspect, setLockAspect] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<'corner' | 'right' | 'bottom' | null>(null);
  const [frozenSpan, setFrozenSpan] = useState<number | null>(null);
  const previewRef = useRef<SVGSVGElement | null>(null);

  // Advanced mode
  const [verts, setVerts] = useState<Point[]>([]);
  const [closed, setClosed] = useState(false);
  const [history, setHistory] = useState<{ verts: Point[]; closed: boolean }[]>([]);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  const [wsIdx, setWsIdx] = useState(1);
  const editorRef = useRef<SVGSVGElement | null>(null);

  const ws = WORKSPACES[wsIdx];
  const snapStep = unit === 'm' ? 5 : 7.62; // 5cm or 3"
  const minorGrid = unit === 'm' ? 10 : 15.24; // 10cm or 6"
  const majorGrid = unit === 'm' ? 50 : 30.48; // 50cm or 1'

  // Reset form whenever the creator opens
  useEffect(() => {
    if (!isOpen) return;
    const it = editingItem;
    setName(it?.name ?? '');
    setColor(it?.color ?? '#0f766e');
    setHistory([]);
    setSelIdx(null);
    setDragIdx(null);
    setHover(null);
    setLockAspect(false);

    if (it?.shape === 'polygon' && it.points && it.points.length >= 3) {
      const idx = WORKSPACES.findIndex((w) => w.w >= it.width * 1.15 && w.h >= it.depth * 1.15);
      const space = WORKSPACES[idx === -1 ? WORKSPACES.length - 1 : idx];
      setWsIdx(idx === -1 ? WORKSPACES.length - 1 : idx);
      setVerts(
        it.points.map((p) => ({ x: space.w / 2 + p.x * it.width, y: space.h / 2 + p.y * it.depth }))
      );
      setClosed(true);
      setMode('advanced');
      setShape('rect');
      setWidth(it.width);
      setDepth(it.depth);
    } else {
      setMode('basic');
      setShape((it?.shape as BasicShapeKind) || 'rect');
      setWidth(it?.width ?? 100);
      setDepth(it?.depth ?? 60);
      setVerts([]);
      setClosed(false);
      setWsIdx(1);
    }
  }, [isOpen, editingItem]);

  // ---------- Advanced editor helpers ----------
  const clampToWs = (p: Point): Point => ({
    x: Math.min(Math.max(p.x, 0), ws.w),
    y: Math.min(Math.max(p.y, 0), ws.h),
  });

  const snapPt = (p: Point): Point =>
    clampToWs(
      snapOn
        ? { x: Math.round(p.x / snapStep) * snapStep, y: Math.round(p.y / snapStep) * snapStep }
        : { x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2 }
    );

  /** Snap + optional Shift-constrained 45° angle relative to an anchor vertex */
  const resolvePt = (raw: Point, anchor: Point | null, shift: boolean): Point => {
    const p = snapPt(raw);
    if (shift && anchor) return clampToWs(snapAngle(anchor, p, snapOn ? snapStep : undefined, snapOn));
    return p;
  };

  const pushHistory = () =>
    setHistory((h) => [...h.slice(-49), { verts: verts.map((v) => ({ ...v })), closed }]);

  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    setVerts(last.verts);
    setClosed(last.closed);
    setHistory((h) => h.slice(0, -1));
    setSelIdx(null);
  };

  const clearShape = () => {
    if (verts.length === 0) return;
    pushHistory();
    setVerts([]);
    setClosed(false);
    setSelIdx(null);
  };

  const closeShape = () => {
    if (closed || verts.length < 3) return;
    pushHistory();
    setClosed(true);
    setSelIdx(null);
  };

  const reopenShape = () => {
    if (!closed) return;
    pushHistory();
    setClosed(false);
  };

  const deleteVertex = (i: number) => {
    if (closed && verts.length <= 3) return;
    pushHistory();
    setVerts((v) => v.filter((_, j) => j !== i));
    setSelIdx(null);
  };

  const loadTemplate = (kind: BasicShapeKind) => {
    let norm = getNormalizedShapePoints(kind);
    if (!norm) {
      norm =
        kind === 'ellipse'
          ? Array.from({ length: 24 }, (_, i) => {
              const a = (i * 2 * Math.PI) / 24;
              return { x: Math.cos(a) * 0.5, y: Math.sin(a) * 0.5 };
            })
          : [
              { x: -0.5, y: -0.5 },
              { x: 0.5, y: -0.5 },
              { x: 0.5, y: 0.5 },
              { x: -0.5, y: 0.5 },
            ];
    }
    // Choose a workspace large enough to fit the template at its current basic dimensions
    let idx = WORKSPACES.findIndex((w) => w.w >= width * 1.15 && w.h >= depth * 1.15);
    if (idx === -1) idx = WORKSPACES.length - 1;
    const space = WORKSPACES[Math.max(idx, wsIdx)];
    setWsIdx(Math.max(idx, wsIdx));
    const w = Math.min(width, space.w);
    const d = Math.min(depth, space.h);
    pushHistory();
    setVerts(
      norm.map((p) => ({
        x: Math.round((space.w / 2 + p.x * w) * 2) / 2,
        y: Math.round((space.h / 2 + p.y * d) * 2) / 2,
      }))
    );
    setClosed(true);
    setSelIdx(null);
  };

  const handleEditorPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !editorRef.current) return;
    if (closed) {
      setSelIdx(null);
      return;
    }
    const raw = toSvgPoint(editorRef.current, e.clientX, e.clientY);
    const anchor = verts.length ? verts[verts.length - 1] : null;
    const p = resolvePt(raw, anchor, e.shiftKey);
    // Ignore duplicate clicks on the same spot
    if (anchor && distance(anchor, p) < 0.5) return;
    pushHistory();
    setVerts((v) => [...v, p]);
    setSelIdx(verts.length);
  };

  const handleEditorPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editorRef.current) return;
    const raw = toSvgPoint(editorRef.current, e.clientX, e.clientY);
    if (dragIdx !== null) {
      const n = verts.length;
      const prevIdx = dragIdx > 0 ? dragIdx - 1 : closed ? n - 1 : null;
      const anchor = prevIdx !== null && prevIdx !== dragIdx ? verts[prevIdx] : null;
      const p = resolvePt(raw, anchor, e.shiftKey);
      setVerts((v) => v.map((q, j) => (j === dragIdx ? p : q)));
    } else if (!closed) {
      const anchor = verts.length ? verts[verts.length - 1] : null;
      setHover(resolvePt(raw, anchor, e.shiftKey));
    }
  };

  const endEditorDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragIdx !== null && editorRef.current?.hasPointerCapture(e.pointerId)) {
      editorRef.current.releasePointerCapture(e.pointerId);
    }
    setDragIdx(null);
  };

  const startVertexDrag = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (!closed && i === 0 && verts.length >= 3) {
      closeShape();
      return;
    }
    pushHistory();
    setSelIdx(i);
    setDragIdx(i);
    editorRef.current?.setPointerCapture(e.pointerId);
  };

  const startMidpointInsert = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const mid = { x: Math.round(((a.x + b.x) / 2) * 2) / 2, y: Math.round(((a.y + b.y) / 2) * 2) / 2 };
    pushHistory();
    setVerts((v) => [...v.slice(0, i + 1), mid, ...v.slice(i + 1)]);
    setSelIdx(i + 1);
    setDragIdx(i + 1);
    editorRef.current?.setPointerCapture(e.pointerId);
  };

  // Isolate keyboard input from global canvas shortcuts while the creator is open
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      e.stopPropagation();
      if (typing) return;

      if (e.key === 'Escape') {
        // Don't discard an in-progress drawing; use Cancel for that
        if (!(mode === 'advanced' && verts.length > 0)) onClose();
        return;
      }
      if (mode !== 'advanced') return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selIdx !== null) {
        e.preventDefault();
        deleteVertex(selIdx);
      } else if (e.key === 'Enter') {
        closeShape();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  });

  // ---------- Basic preview resizing ----------
  const autoSpan = Math.max(150, Math.ceil((Math.max(width, depth) * 1.4) / 50) * 50);
  const span = frozenSpan ?? autoSpan;

  const handlePreviewMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!resizeHandle || !previewRef.current) return;
    const p = toSvgPoint(previewRef.current, e.clientX, e.clientY);
    const step = unit === 'm' ? 5 : 2.54;
    const snap = (v: number) => Math.max(MIN_SIZE * 2, Math.round((Math.abs(v) * 2) / step) * step);
    let w = width;
    let d = depth;
    if (resizeHandle === 'corner' || resizeHandle === 'right') w = snap(p.x);
    if (resizeHandle === 'corner' || resizeHandle === 'bottom') d = snap(p.y);
    if (lockAspect) {
      const ratio = depth / width;
      if (resizeHandle === 'bottom') w = d / ratio;
      else d = w * ratio;
    }
    setWidth(w);
    setDepth(d);
  };

  const startResize = (e: React.PointerEvent, handle: 'corner' | 'right' | 'bottom') => {
    e.stopPropagation();
    setResizeHandle(handle);
    setFrozenSpan(span);
    previewRef.current?.setPointerCapture(e.pointerId);
  };

  const endResize = (e: React.PointerEvent<SVGSVGElement>) => {
    if (previewRef.current?.hasPointerCapture(e.pointerId)) {
      previewRef.current.releasePointerCapture(e.pointerId);
    }
    setResizeHandle(null);
    setFrozenSpan(null);
  };

  const setWidthLocked = (cm: number) => {
    if (lockAspect && width > 0) setDepth(Math.round(cm * (depth / width) * 10) / 10);
    setWidth(cm);
  };
  const setDepthLocked = (cm: number) => {
    if (lockAspect && depth > 0) setWidth(Math.round(cm * (width / depth) * 10) / 10);
    setDepth(cm);
  };

  // ---------- Derived info / save ----------
  const polyInfo = useMemo(() => {
    if (verts.length < 2) return null;
    const n = normalizePolygon(verts);
    return { width: n.width, depth: n.depth, area: verts.length >= 3 ? polygonArea(verts) : 0 };
  }, [verts]);

  const scalePoly = (newW: number, newD: number) => {
    if (!verts.length) return;
    const xs = verts.map((p) => p.x);
    const ys = verts.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const curW = Math.max(maxX - minX, 0.01);
    const curD = Math.max(maxY - minY, 0.01);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const sx = newW / curW;
    const sy = newD / curD;

    const newVerts = verts.map((p) => ({
      x: cx + (p.x - cx) * sx,
      y: cy + (p.y - cy) * sy,
    }));

    // Auto expand workspace if necessary to prevent vertices going out of bounds
    const requiredW = Math.max(...newVerts.map((p) => Math.abs(p.x - ws.w / 2))) * 2 * 1.15;
    const requiredH = Math.max(...newVerts.map((p) => Math.abs(p.y - ws.h / 2))) * 2 * 1.15;
    const idx = WORKSPACES.findIndex((w) => w.w >= requiredW && w.h >= requiredH);
    if (idx !== -1 && idx > wsIdx) {
      setWsIdx(idx);
    }

    pushHistory();
    setVerts(newVerts);
    setWidth(newW);
    setDepth(newD);
  };

  const handleScalePolyWidth = (newW: number) => {
    if (!polyInfo || polyInfo.width <= 0) {
      setWidth(newW);
      return;
    }
    const newD = lockAspect ? (newW * polyInfo.depth) / polyInfo.width : polyInfo.depth;
    scalePoly(newW, newD);
  };

  const handleScalePolyDepth = (newD: number) => {
    if (!polyInfo || polyInfo.depth <= 0) {
      setDepth(newD);
      return;
    }
    const newW = lockAspect ? (newD * polyInfo.width) / polyInfo.depth : polyInfo.width;
    scalePoly(newW, newD);
  };

  const shapeLabel = BASIC_SHAPES.find((s) => s.id === shape)?.label ?? 'Shape';
  const canSaveAdvanced =
    closed && verts.length >= 3 && !!polyInfo && polyInfo.width >= MIN_SIZE && polyInfo.depth >= MIN_SIZE;
  const canSave = mode === 'basic' ? width >= MIN_SIZE && depth >= MIN_SIZE : canSaveAdvanced;

  const buildItem = (): FurnitureCatalogItem | null => {
    const catalogId = editingItem?.catalogId ?? `custom_${Date.now()}`;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    if (mode === 'basic') {
      return {
        catalogId,
        name: name.trim() || `Custom ${shapeLabel}`,
        category: 'custom',
        width: r1(width),
        depth: r1(depth),
        color,
        iconType: 'custom',
        shape,
        description: `Custom ${shapeLabel.toLowerCase()} (${formatDimension(width, unit)} × ${formatDimension(depth, unit)})`,
      };
    }
    if (!canSaveAdvanced) return null;
    const n = normalizePolygon(verts);
    return {
      catalogId,
      name: name.trim() || 'Custom Shape',
      category: 'custom',
      width: r1(n.width),
      depth: r1(n.depth),
      color,
      iconType: 'custom',
      shape: 'polygon',
      points: n.points,
      description: `Custom freeform shape with ${verts.length} corners`,
    };
  };

  const handleSave = (placeNow: boolean) => {
    const item = buildItem();
    if (item) onSave(item, placeNow);
  };

  if (!isOpen) return null;

  // Editor sizing relative to workspace
  const hr = ws.w / 110; // handle radius
  const sw = ws.w / 400; // stroke width
  const fs = ws.w / 50; // font size
  const n = verts.length;
  const segments: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) segments.push([i, i + 1]);
  if (closed && n >= 3) segments.push([n - 1, 0]);

  const hint =
    n === 0
      ? 'Click on the grid to place the first corner. Hold Shift to lock angles to 45°.'
      : !closed
      ? n < 3
        ? 'Keep clicking to add corners.'
        : 'Click the first corner (or press Enter) to close the shape.'
      : 'Drag corners to adjust · Drag a + handle to add a corner · Double-click a corner (or select + Delete) to remove it.';

  return createPortal(
    <div className="modal-backdrop">
      <div className="modal-card creator-modal-card" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title">{editingItem ? 'Edit Custom Object' : 'Create Custom Object'}</h3>
            <p className="import-subtitle">Saved to your catalog under the Custom tag for this session.</p>
          </div>
          <button className="modal-close" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="creator-body">
          {/* Left: settings */}
          <div className="creator-settings">
            <div className="field-group">
              <label className="field-label">Name</label>
              <input
                type="text"
                className="field-input"
                placeholder={mode === 'basic' ? `Custom ${shapeLabel}` : 'Custom Shape'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>

            <div className="field-group">
              <label className="field-label">Color</label>
              <div className="creator-colors">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`color-swatch ${color === c ? 'selected' : ''}`}
                    style={{ backgroundColor: c }}
                    onClick={() => setColor(c)}
                  />
                ))}
                <label className="color-swatch creator-color-picker" title="Pick any color">
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
                  <Plus size={14} />
                </label>
              </div>
            </div>

            <div className="field-group">
              <label className="field-label">Mode</label>
              <div className="segmented-control creator-mode-toggle">
                <button
                  className={`segment-btn ${mode === 'basic' ? 'active' : ''}`}
                  onClick={() => {
                    if (polyInfo) {
                      setWidth(Math.round(polyInfo.width * 10) / 10);
                      setDepth(Math.round(polyInfo.depth * 10) / 10);
                    }
                    setMode('basic');
                  }}
                >
                  <Shapes size={13} /> Basic
                </button>
                <button
                  className={`segment-btn ${mode === 'advanced' ? 'active' : ''}`}
                  onClick={() => {
                    if (verts.length === 0) {
                      loadTemplate(shape);
                    }
                    setMode('advanced');
                  }}
                >
                  <PenTool size={13} /> Advanced
                </button>
              </div>
            </div>

            <div className="divider" />

            {mode === 'basic' ? (
              <>
                <div className="field-group">
                  <label className="field-label">Shape</label>
                  <div className="creator-shape-grid">
                    {BASIC_SHAPES.map((s) => (
                      <button
                        key={s.id}
                        className={`creator-shape-btn ${shape === s.id ? 'active' : ''}`}
                        onClick={() => setShape(s.id)}
                        title={s.label}
                      >
                        <ShapeThumbnail shape={s.id} width={40} depth={40} color={shape === s.id ? color : '#94a3b8'} size={30} />
                        <span>{s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field-row creator-dims-row">
                  <DimInput label="Width" valueCm={width} unit={unit} onChange={setWidthLocked} />
                  <button
                    className={`tool-btn-icon creator-lock-btn ${lockAspect ? 'active' : ''}`}
                    onClick={() => setLockAspect((l) => !l)}
                    title={lockAspect ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  >
                    {lockAspect ? <Lock size={14} /> : <Unlock size={14} />}
                  </button>
                  <DimInput label="Depth" valueCm={depth} unit={unit} onChange={setDepthLocked} />
                </div>
                <p className="creator-note">
                  Drag the handles in the preview to resize. Placed objects can also be resized on the canvas.
                </p>
              </>
            ) : (
              <>
                <div className="field-group">
                  <label className="field-label">Start from</label>
                  <select
                    className="select-dropdown"
                    value=""
                    onChange={(e) => e.target.value && loadTemplate(e.target.value as BasicShapeKind)}
                  >
                    <option value="">Blank / choose a template…</option>
                    {BASIC_SHAPES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field-row">
                  <div className="field-group flex-1">
                    <label className="field-label">Workspace</label>
                    <select
                      className="select-dropdown"
                      value={wsIdx}
                      onChange={(e) => setWsIdx(parseInt(e.target.value))}
                    >
                      {WORKSPACES.map((w, i) => (
                        <option key={i} value={i}>
                          {formatDimension(w.w, unit)} × {formatDimension(w.h, unit)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="creator-tool-row">
                  <button
                    className={`btn-secondary ${snapOn ? 'active' : ''}`}
                    onClick={() => setSnapOn((s) => !s)}
                    title={`Snap to ${formatDimension(snapStep, unit)} grid`}
                  >
                    <Magnet size={14} /> Snap
                  </button>
                  <button className="btn-secondary" onClick={undo} disabled={!history.length} title="Undo (⌘/Ctrl+Z)">
                    <Undo2 size={14} /> Undo
                  </button>
                  <button className="btn-secondary" onClick={clearShape} disabled={!n} title="Clear all points">
                    <Trash2 size={14} /> Clear
                  </button>
                </div>
                {closed ? (
                  <button className="btn-secondary w-full" onClick={reopenShape}>
                    <PenTool size={14} /> Reopen to add points at end
                  </button>
                ) : (
                  <button className="btn-secondary w-full" onClick={closeShape} disabled={n < 3}>
                    <Check size={14} /> Close shape
                  </button>
                )}

                {polyInfo && (
                  <div className="field-group">
                    <label className="field-label">Dimensions</label>
                    <div className="field-row creator-dims-row">
                      <DimInput
                        label="Width"
                        valueCm={polyInfo.width}
                        unit={unit}
                        onChange={handleScalePolyWidth}
                      />
                      <button
                        className={`tool-btn-icon creator-lock-btn ${lockAspect ? 'active' : ''}`}
                        onClick={() => setLockAspect((l) => !l)}
                        title={lockAspect ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                      >
                        {lockAspect ? <Lock size={14} /> : <Unlock size={14} />}
                      </button>
                      <DimInput
                        label="Depth"
                        valueCm={polyInfo.depth}
                        unit={unit}
                        onChange={handleScalePolyDepth}
                      />
                    </div>
                  </div>
                )}

                <div className="stats-box">
                  <span className="stats-header">Shape Info</span>
                  <div className="stats-row">
                    <span>Corners</span>
                    <span className="font-mono">{n}</span>
                  </div>
                  <div className="stats-row">
                    <span>Footprint</span>
                    <span className="font-mono">
                      {polyInfo
                        ? `${formatDimension(polyInfo.width, unit)} × ${formatDimension(polyInfo.depth, unit)}`
                        : '—'}
                    </span>
                  </div>
                  <div className="stats-row">
                    <span>Area</span>
                    <span className="font-mono">
                      {polyInfo && closed ? formatArea(polyInfo.area, unit) : '—'}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Right: preview / drawing panel */}
          <div className="creator-stage">
            <div className="creator-stage-header">
              <span>{mode === 'basic' ? 'Preview' : 'Shape Editor'}</span>
              <span className="font-mono">
                {mode === 'basic'
                  ? `${formatDimension(width, unit)} × ${formatDimension(depth, unit)}`
                  : `Grid ${formatDimension(minorGrid, unit)}`}
              </span>
            </div>

            {mode === 'basic' ? (
              <svg
                ref={previewRef}
                className="creator-svg"
                viewBox={`${-span / 2} ${-span / 2} ${span} ${span}`}
                preserveAspectRatio="xMidYMid meet"
                onPointerMove={handlePreviewMove}
                onPointerUp={endResize}
                onPointerCancel={endResize}
              >
                <defs>
                  <pattern
                    id="creatorPreviewGrid"
                    x={0}
                    y={0}
                    width={majorGrid}
                    height={majorGrid}
                    patternUnits="userSpaceOnUse"
                  >
                    <path
                      d={`M ${majorGrid} 0 L 0 0 0 ${majorGrid}`}
                      fill="none"
                      stroke="#e2e8f0"
                      strokeWidth={span / 400}
                    />
                  </pattern>
                </defs>
                <rect x={-span / 2} y={-span / 2} width={span} height={span} fill="url(#creatorPreviewGrid)" />
                <ShapeBody
                  shape={shape}
                  width={width}
                  depth={depth}
                  fill={color}
                  strokeWidth={span / 250}
                />
                <rect
                  x={-width / 2}
                  y={-depth / 2}
                  width={width}
                  height={depth}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={span / 400}
                  strokeDasharray={`${span / 80} ${span / 160}`}
                />
                <text
                  x={0}
                  y={-depth / 2 - span / 40}
                  textAnchor="middle"
                  fontSize={span / 28}
                  fontWeight="700"
                  fill="#2563eb"
                  fontFamily="monospace"
                >
                  {formatDimension(width, unit)}
                </text>
                <text
                  x={width / 2 + span / 40}
                  y={0}
                  dominantBaseline="central"
                  fontSize={span / 28}
                  fontWeight="700"
                  fill="#2563eb"
                  fontFamily="monospace"
                >
                  {formatDimension(depth, unit)}
                </text>
                {/* Resize handles */}
                <rect
                  className="cursor-ew-resize"
                  x={width / 2 - span / 120}
                  y={-span / 24}
                  width={span / 60}
                  height={span / 12}
                  rx={span / 200}
                  fill="#2563eb"
                  stroke="#fff"
                  strokeWidth={span / 400}
                  onPointerDown={(e) => startResize(e, 'right')}
                />
                <rect
                  className="cursor-ns-resize"
                  x={-span / 24}
                  y={depth / 2 - span / 120}
                  width={span / 12}
                  height={span / 60}
                  rx={span / 200}
                  fill="#2563eb"
                  stroke="#fff"
                  strokeWidth={span / 400}
                  onPointerDown={(e) => startResize(e, 'bottom')}
                />
                <circle
                  className="cursor-nwse-resize"
                  cx={width / 2}
                  cy={depth / 2}
                  r={span / 55}
                  fill="#2563eb"
                  stroke="#fff"
                  strokeWidth={span / 300}
                  onPointerDown={(e) => startResize(e, 'corner')}
                />
              </svg>
            ) : (
              <svg
                ref={editorRef}
                className={`creator-svg ${closed ? '' : 'creator-svg-drawing'}`}
                viewBox={`0 0 ${ws.w} ${ws.h}`}
                preserveAspectRatio="xMidYMid meet"
                onPointerDown={handleEditorPointerDown}
                onPointerMove={handleEditorPointerMove}
                onPointerUp={endEditorDrag}
                onPointerCancel={endEditorDrag}
                onPointerLeave={() => setHover(null)}
              >
                <defs>
                  <pattern id="creatorMinor" width={minorGrid} height={minorGrid} patternUnits="userSpaceOnUse">
                    <path
                      d={`M ${minorGrid} 0 L 0 0 0 ${minorGrid}`}
                      fill="none"
                      stroke="#eef2f7"
                      strokeWidth={sw * 0.8}
                    />
                  </pattern>
                  <pattern id="creatorMajor" width={majorGrid} height={majorGrid} patternUnits="userSpaceOnUse">
                    <rect width={majorGrid} height={majorGrid} fill="url(#creatorMinor)" />
                    <path
                      d={`M ${majorGrid} 0 L 0 0 0 ${majorGrid}`}
                      fill="none"
                      stroke="#cbd5e1"
                      strokeWidth={sw}
                    />
                  </pattern>
                </defs>
                <rect width={ws.w} height={ws.h} fill="#ffffff" />
                <rect width={ws.w} height={ws.h} fill="url(#creatorMajor)" />

                {/* Shape body */}
                {closed && n >= 3 ? (
                  <polygon
                    points={verts.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill={color}
                    fillOpacity={0.6}
                    stroke="#0f172a"
                    strokeWidth={sw * 1.5}
                    strokeLinejoin="round"
                  />
                ) : (
                  n > 1 && (
                    <polyline
                      points={verts.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke={color}
                      strokeWidth={sw * 2.5}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  )
                )}

                {/* Rubber-band preview line */}
                {!closed && n > 0 && hover && dragIdx === null && (
                  <line
                    x1={verts[n - 1].x}
                    y1={verts[n - 1].y}
                    x2={hover.x}
                    y2={hover.y}
                    stroke="#2563eb"
                    strokeWidth={sw * 1.5}
                    strokeDasharray={`${sw * 6} ${sw * 4}`}
                    pointerEvents="none"
                  />
                )}
                {!closed && hover && dragIdx === null && (
                  <circle cx={hover.x} cy={hover.y} r={hr * 0.5} fill="#2563eb" fillOpacity={0.5} pointerEvents="none" />
                )}

                {/* Edge length labels */}
                {segments.map(([a, b]) => {
                  const len = distance(verts[a], verts[b]);
                  if (len < ws.w / 14) return null;
                  return (
                    <text
                      key={`len-${a}-${b}`}
                      x={(verts[a].x + verts[b].x) / 2}
                      y={(verts[a].y + verts[b].y) / 2 - hr * 1.6}
                      textAnchor="middle"
                      fontSize={fs}
                      fontWeight="700"
                      fill="#334155"
                      fontFamily="monospace"
                      stroke="#ffffff"
                      strokeWidth={fs / 4}
                      paintOrder="stroke"
                      pointerEvents="none"
                    >
                      {formatDimension(len, unit)}
                    </text>
                  );
                })}

                {/* Midpoint insert handles */}
                {dragIdx === null &&
                  segments.map(([a, b]) => {
                    if (distance(verts[a], verts[b]) < hr * 5) return null;
                    const mx = (verts[a].x + verts[b].x) / 2;
                    const my = (verts[a].y + verts[b].y) / 2;
                    return (
                      <g
                        key={`mid-${a}-${b}`}
                        className="creator-mid-handle"
                        onPointerDown={(e) => startMidpointInsert(e, a)}
                      >
                        <circle cx={mx} cy={my} r={hr * 0.75} fill="#ffffff" stroke="#2563eb" strokeWidth={sw} />
                        <path
                          d={`M ${mx - hr * 0.4} ${my} H ${mx + hr * 0.4} M ${mx} ${my - hr * 0.4} V ${my + hr * 0.4}`}
                          stroke="#2563eb"
                          strokeWidth={sw}
                        />
                      </g>
                    );
                  })}

                {/* Vertices */}
                {verts.map((p, i) => {
                  const isFirstClosable = !closed && i === 0 && n >= 3;
                  return (
                    <circle
                      key={`v-${i}`}
                      cx={p.x}
                      cy={p.y}
                      r={isFirstClosable ? hr * 1.35 : hr}
                      fill={selIdx === i ? '#2563eb' : isFirstClosable ? '#dcfce7' : '#ffffff'}
                      stroke={isFirstClosable ? '#16a34a' : '#2563eb'}
                      strokeWidth={sw * 1.5}
                      className="creator-vertex"
                      onPointerDown={(e) => startVertexDrag(e, i)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        deleteVertex(i);
                      }}
                    />
                  );
                })}
              </svg>
            )}

            <div className="creator-hint">
              {mode === 'basic'
                ? 'Need a shape that isn’t listed? Switch to Advanced to draw your own.'
                : hint}
            </div>
          </div>
        </div>

        <div className="creator-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => handleSave(false)} disabled={!canSave}>
              Save to Catalog
            </button>
            <button className="btn-primary" onClick={() => handleSave(true)} disabled={!canSave}>
              <Check size={14} /> Save &amp; Place
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
