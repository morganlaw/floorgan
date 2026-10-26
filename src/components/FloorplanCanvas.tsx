import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  FloorplanState,
  ToolMode,
  Point,
  Wall,
  Door,
  WindowItem,
  Measurement,
  TextBoxItem,
  SelectedElementType,
} from '../types';
import {
  snapPointToGrid,
  distance,
  snapAngle,
  formatDimension,
} from '../utils/geometry';
import { rescaleFloorplanState } from '../utils/floorplanParser';
import { ShapeBody } from './ShapeBody';

interface Props {
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  tool: ToolMode;
  setTool: (tool: ToolMode) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedIds?: string[];
  setSelectedIds?: (ids: string[]) => void;
  selectedType: SelectedElementType;
  setSelectedType: (type: SelectedElementType) => void;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  pan: Point;
  setPan: React.Dispatch<React.SetStateAction<Point>>;
  onStartInteraction?: () => void;
  onEndInteraction?: () => void;
}

function wrapTextBoxLines(text: string, fontSize: number, maxLineWidth: number): string[] {
  const rawParagraphs = (text || '').split('\n');
  const avgCharWidth = fontSize * 0.58;
  const maxCharsPerLine = Math.max(1, Math.floor(maxLineWidth / avgCharWidth));

  const result: string[] = [];
  for (const paragraph of rawParagraphs) {
    if (paragraph.length <= maxCharsPerLine) {
      result.push(paragraph);
      continue;
    }
    const words = paragraph.split(' ');
    let currentLine = '';
    for (const word of words) {
      if (!currentLine) {
        currentLine = word;
      } else if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
        currentLine += ' ' + word;
      } else {
        result.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) {
      result.push(currentLine);
    }
  }
  return result.length > 0 ? result : [''];
}

export const FloorplanCanvas: React.FC<Props> = ({
  state,
  setState,
  tool,
  setTool,
  selectedId,
  setSelectedId,
  selectedIds = [],
  setSelectedIds,
  selectedType,
  setSelectedType,
  zoom,
  setZoom,
  pan,
  setPan,
  onStartInteraction,
  onEndInteraction,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<Point>({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  const [selectionBox, setSelectionBox] = useState<{ start: Point; current: Point } | null>(null);

  const [dragStartPoint, setDragStartPoint] = useState<Point | null>(null);
  const [dragInitialPositions, setDragInitialPositions] = useState<{ [id: string]: Point & { endX?: number; endY?: number } }>({});

  const [wallStart, setWallStart] = useState<Point | null>(null);
  const [wallCurrent, setWallCurrent] = useState<Point | null>(null);

  const [doorStart, setDoorStart] = useState<Point | null>(null);
  const [doorCurrent, setDoorCurrent] = useState<Point | null>(null);

  const [windowStart, setWindowStart] = useState<Point | null>(null);
  const [windowCurrent, setWindowCurrent] = useState<Point | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<Point>({ x: 0, y: 0 });

  const [isRotating, setIsRotating] = useState(false);

  const [resizeTarget, setResizeTarget] = useState<{
    id: string;
    type: 'door' | 'window' | 'furniture' | 'textbox' | 'wall';
    handle: 'left' | 'right' | 'top' | 'bottom' | 'nw' | 'ne' | 'se' | 'sw' | 'start' | 'end';
  } | null>(null);

  const [measureStart, setMeasureStart] = useState<Point | null>(null);
  const [measureEnd, setMeasureEnd] = useState<Point | null>(null);

  const [calibStart, setCalibStart] = useState<Point | null>(null);
  const [calibEnd, setCalibEnd] = useState<Point | null>(null);
  const [pendingCalibDistCm, setPendingCalibDistCm] = useState<number | null>(null);
  const [calibInputValue, setCalibInputValue] = useState<string>('4.0');

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      if (!svgRef.current) return { x: 0, y: 0 };
      const rect = svgRef.current.getBoundingClientRect();
      const rawX = (clientX - rect.left - pan.x) / zoom;
      const rawY = (clientY - rect.top - pan.y) / zoom;
      return { x: rawX, y: rawY };
    },
    [pan, zoom]
  );

  // Mouse wheel zoom (attached with { passive: false } so preventDefault works without console warnings)
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const handleNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(Math.max(zoom * zoomFactor, 0.2), 4.0);

      const rect = svgEl.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      setPan((prevPan) => ({
        x: cursorX - ((cursorX - prevPan.x) / zoom) * newZoom,
        y: cursorY - ((cursorY - prevPan.y) / zoom) * newZoom,
      }));
      setZoom(newZoom);
    };

    svgEl.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => {
      svgEl.removeEventListener('wheel', handleNativeWheel);
    };
  }, [zoom]);

  // Touch gestures: Pinch-to-zoom and two-finger pan
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    let touchGesture: {
      initialDist: number;
      initialZoom: number;
      initialPan: { x: number; y: number };
      initialMidX: number;
      initialMidY: number;
    } | null = null;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const rect = svgEl.getBoundingClientRect();
        touchGesture = {
          initialDist: Math.max(dist, 1),
          initialZoom: zoom,
          initialPan: { ...pan },
          initialMidX: (t1.clientX + t2.clientX) / 2 - rect.left,
          initialMidY: (t1.clientY + t2.clientY) / 2 - rect.top,
        };
      } else {
        touchGesture = null;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && touchGesture) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const rect = svgEl.getBoundingClientRect();
        const curMidX = (t1.clientX + t2.clientX) / 2 - rect.left;
        const curMidY = (t1.clientY + t2.clientY) / 2 - rect.top;

        const scale = dist / touchGesture.initialDist;
        const newZoom = Math.min(Math.max(touchGesture.initialZoom * scale, 0.2), 4.0);

        const dx = curMidX - touchGesture.initialMidX;
        const dy = curMidY - touchGesture.initialMidY;

        setZoom(newZoom);
        setPan({
          x:
            touchGesture.initialMidX -
            ((touchGesture.initialMidX - touchGesture.initialPan.x) / touchGesture.initialZoom) *
              newZoom +
            dx,
          y:
            touchGesture.initialMidY -
            ((touchGesture.initialMidY - touchGesture.initialPan.y) / touchGesture.initialZoom) *
              newZoom +
            dy,
        });
      }
    };

    const handleTouchEnd = () => {
      touchGesture = null;
    };

    svgEl.addEventListener('touchstart', handleTouchStart, { passive: false });
    svgEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    svgEl.addEventListener('touchend', handleTouchEnd);
    svgEl.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      svgEl.removeEventListener('touchstart', handleTouchStart);
      svgEl.removeEventListener('touchmove', handleTouchMove);
      svgEl.removeEventListener('touchend', handleTouchEnd);
      svgEl.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [zoom, pan]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || tool === 'pan' || isSpacePressed) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }

    if (e.button !== 0) return;

    const worldPoint = screenToWorld(e.clientX, e.clientY);
    const snappedPoint = snapPointToGrid(worldPoint, state.gridSize, state.gridSnap);

    if (tool === 'wall') {
      if (!wallStart) {
        setWallStart(snappedPoint);
        setWallCurrent(snappedPoint);
      } else {
        const finalEnd = snapAngle(wallStart, snappedPoint, state.gridSize, state.gridSnap);
        if (distance(wallStart, finalEnd) > 10) {
          const newWall: Wall = {
            id: 'wall_' + Date.now(),
            start: wallStart,
            end: finalEnd,
            thickness: 15,
          };
          setState((prev) => ({ ...prev, walls: [...prev.walls, newWall] }));
          setWallStart(null);
          setWallCurrent(null);
          setTool('select');
          setSelectedId(newWall.id);
          setSelectedType('wall');
        }
      }
    } else if (tool === 'door') {
      if (!doorStart) {
        setDoorStart(snappedPoint);
        setDoorCurrent(snappedPoint);
      } else {
        const finalEnd = snapAngle(doorStart, snappedPoint, state.gridSize, state.gridSnap);
        const dist = distance(doorStart, finalEnd);
        if (dist >= 30) {
          const mid = { x: (doorStart.x + finalEnd.x) / 2, y: (doorStart.y + finalEnd.y) / 2 };
          const angleRad = Math.atan2(finalEnd.y - doorStart.y, finalEnd.x - doorStart.x);
          const angleDeg = Math.round((angleRad * 180) / Math.PI);
          const newDoor: Door = {
            id: 'door_' + Date.now(),
            x: Math.round(mid.x),
            y: Math.round(mid.y),
            width: Math.round(dist),
            rotation: (angleDeg + 360) % 360,
            swingDirection: 'left',
          };
          setState((prev) => ({ ...prev, doors: [...prev.doors, newDoor] }));
          setDoorStart(null);
          setDoorCurrent(null);
          setTool('select');
          setSelectedId(newDoor.id);
          setSelectedType('door');
        }
      }
    } else if (tool === 'window') {
      if (!windowStart) {
        setWindowStart(snappedPoint);
        setWindowCurrent(snappedPoint);
      } else {
        const finalEnd = snapAngle(windowStart, snappedPoint, state.gridSize, state.gridSnap);
        const dist = distance(windowStart, finalEnd);
        if (dist >= 30) {
          const mid = { x: (windowStart.x + finalEnd.x) / 2, y: (windowStart.y + finalEnd.y) / 2 };
          const angleRad = Math.atan2(finalEnd.y - windowStart.y, finalEnd.x - windowStart.x);
          const angleDeg = Math.round((angleRad * 180) / Math.PI);
          const newWin: WindowItem = {
            id: 'win_' + Date.now(),
            x: Math.round(mid.x),
            y: Math.round(mid.y),
            width: Math.round(dist),
            thickness: 15,
            rotation: (angleDeg + 360) % 360,
          };
          setState((prev) => ({ ...prev, windows: [...prev.windows, newWin] }));
          setWindowStart(null);
          setWindowCurrent(null);
          setTool('select');
          setSelectedId(newWin.id);
          setSelectedType('window');
        }
      }
    } else if (tool === 'measure') {
      if (!measureStart) {
        setMeasureStart(snappedPoint);
        setMeasureEnd(snappedPoint);
      } else {
        const finalEnd = e.shiftKey ? snapAngle(measureStart, snappedPoint) : snappedPoint;
        if (distance(measureStart, finalEnd) > 5) {
          const newMeasurement: Measurement = {
            id: 'measure_' + Date.now(),
            start: measureStart,
            end: finalEnd,
          };
          setState((prev) => ({
            ...prev,
            measurements: [...prev.measurements, newMeasurement],
          }));
          setMeasureStart(null);
          setMeasureEnd(null);
          setSelectedId(newMeasurement.id);
          setSelectedType('measurement');
          setTool('select');
        }
      }
    } else if (tool === 'text') {
      onStartInteraction?.();
      const newTextBox: TextBoxItem = {
        id: 'text_' + Date.now(),
        text: 'Custom Text',
        x: Math.round(snappedPoint.x),
        y: Math.round(snappedPoint.y),
        width: 130,
        height: 50,
        fontSize: 16,
        color: '#1e293b',
        backgroundColor: '#ffffff',
        borderColor: '#cbd5e1',
        borderStyle: 'solid',
        borderRadius: 6,
        rotation: 0,
        textAlign: 'center',
        bold: false,
        italic: false,
      };
      setState((prev) => ({
        ...prev,
        textBoxes: [...(prev.textBoxes || []), newTextBox],
      }));
      setTool('select');
      setSelectedId(newTextBox.id);
      setSelectedType('textbox');
    } else if (tool === 'calibrate') {
      if (!calibStart) {
        setCalibStart(snappedPoint);
        setCalibEnd(snappedPoint);
      } else {
        const finalEnd = e.shiftKey ? snapAngle(calibStart, snappedPoint) : snappedPoint;
        const measuredCm = distance(calibStart, finalEnd);
        if (measuredCm > 10) {
          setPendingCalibDistCm(measuredCm);
          const defaultVal =
            state.unit === 'm'
              ? (measuredCm / 100).toFixed(2)
              : (measuredCm / 30.48).toFixed(1);
          setCalibInputValue(defaultVal);
          setCalibStart(null);
          setCalibEnd(null);
        }
      }
    } else if (tool === 'select') {
      setSelectionBox({ start: worldPoint, current: worldPoint });
      if (!e.shiftKey) {
        setSelectedId(null);
        setSelectedType(null);
        setSelectedIds?.([]);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
      return;
    }

    const worldPoint = screenToWorld(e.clientX, e.clientY);
    const snappedPoint = snapPointToGrid(worldPoint, state.gridSize, state.gridSnap);

    if (tool === 'wall' && wallStart) {
      setWallCurrent(snapAngle(wallStart, snappedPoint, state.gridSize, state.gridSnap));
    }

    if (tool === 'door' && doorStart) {
      setDoorCurrent(snapAngle(doorStart, snappedPoint, state.gridSize, state.gridSnap));
    }

    if (tool === 'window' && windowStart) {
      setWindowCurrent(snapAngle(windowStart, snappedPoint, state.gridSize, state.gridSnap));
    }

    if (tool === 'measure' && measureStart) {
      setMeasureEnd(snappedPoint);
    }

    if (tool === 'calibrate' && calibStart) {
      setCalibEnd(snapAngle(calibStart, snappedPoint, state.gridSize, state.gridSnap));
    }

    if (selectionBox) {
      setSelectionBox((prev) => (prev ? { ...prev, current: worldPoint } : null));
    }

    if (resizeTarget && selectedId) {
      if (resizeTarget.type === 'door') {
        const door = state.doors.find((d) => d.id === selectedId);
        if (door) {
          const rad = (door.rotation * Math.PI) / 180;
          const ux = Math.cos(rad);
          const uy = Math.sin(rad);
          const dx = worldPoint.x - door.x;
          const dy = worldPoint.y - door.y;
          const proj = dx * ux + dy * uy;
          let half = Math.abs(proj);
          if (state.gridSnap) {
            half = Math.max(15, Math.round(half / (state.gridSize / 2)) * (state.gridSize / 2));
          }
          const newWidth = Math.max(30, Math.round(half * 2));
          setState((prev) => ({
            ...prev,
            doors: prev.doors.map((d) => (d.id === selectedId ? { ...d, width: newWidth } : d)),
          }));
        }
      } else if (resizeTarget.type === 'window') {
        const win = state.windows.find((w) => w.id === selectedId);
        if (win) {
          const rad = (win.rotation * Math.PI) / 180;
          const ux = Math.cos(rad);
          const uy = Math.sin(rad);
          const dx = worldPoint.x - win.x;
          const dy = worldPoint.y - win.y;
          const proj = dx * ux + dy * uy;
          let half = Math.abs(proj);
          if (state.gridSnap) {
            half = Math.max(15, Math.round(half / (state.gridSize / 2)) * (state.gridSize / 2));
          }
          const newWidth = Math.max(30, Math.round(half * 2));
          setState((prev) => ({
            ...prev,
            windows: prev.windows.map((w) => (w.id === selectedId ? { ...w, width: newWidth } : w)),
          }));
        }
      } else if (resizeTarget.type === 'furniture') {
        const furn = state.furniture.find((f) => f.id === selectedId);
        if (furn) {
          const rad = (furn.rotation * Math.PI) / 180;
          const ux = Math.cos(rad);
          const uy = Math.sin(rad);
          const dx = worldPoint.x - furn.x;
          const dy = worldPoint.y - furn.y;

          if (resizeTarget.handle === 'left' || resizeTarget.handle === 'right') {
            const proj = dx * ux + dy * uy;
            let half = Math.abs(proj);
            if (state.gridSnap) {
              half = Math.max(15, Math.round(half / (state.gridSize / 2)) * (state.gridSize / 2));
            }
            const newWidth = Math.max(30, Math.round(half * 2));
            setState((prev) => ({
              ...prev,
              furniture: prev.furniture.map((f) =>
                f.id === selectedId ? { ...f, width: newWidth } : f
              ),
            }));
          } else if (resizeTarget.handle === 'top' || resizeTarget.handle === 'bottom') {
            const projY = -dx * uy + dy * ux;
            let half = Math.abs(projY);
            if (state.gridSnap) {
              half = Math.max(15, Math.round(half / (state.gridSize / 2)) * (state.gridSize / 2));
            }
            const newDepth = Math.max(30, Math.round(half * 2));
            setState((prev) => ({
              ...prev,
              furniture: prev.furniture.map((f) =>
                f.id === selectedId ? { ...f, depth: newDepth } : f
              ),
            }));
          }
        }
      } else if (resizeTarget.type === 'textbox') {
        const tb = (state.textBoxes || []).find((t) => t.id === selectedId);
        if (tb) {
          const rad = (tb.rotation * Math.PI) / 180;
          const ux = Math.cos(rad);
          const uy = Math.sin(rad);
          const vx = -Math.sin(rad);
          const vy = Math.cos(rad);

          const curW = tb.width;
          const curH = tb.height;
          const halfW = curW / 2;
          const halfH = curH / 2;

          let newWidth = curW;
          let newHeight = curH;
          let newCenterX = tb.x;
          let newCenterY = tb.y;

          const snapDim = (val: number, minVal: number) => {
            let res = Math.max(minVal, val);
            if (state.gridSnap) {
              res = Math.max(minVal, Math.round(res / state.gridSize) * state.gridSize);
            }
            return res;
          };

          if (resizeTarget.handle === 'right') {
            const anchorX = tb.x - halfW * ux;
            const anchorY = tb.y - halfW * uy;
            const dist = (worldPoint.x - anchorX) * ux + (worldPoint.y - anchorY) * uy;
            newWidth = snapDim(dist, 40);
            newCenterX = anchorX + (newWidth / 2) * ux;
            newCenterY = anchorY + (newWidth / 2) * uy;
          } else if (resizeTarget.handle === 'left') {
            const anchorX = tb.x + halfW * ux;
            const anchorY = tb.y + halfW * uy;
            const dist = (anchorX - worldPoint.x) * ux + (anchorY - worldPoint.y) * uy;
            newWidth = snapDim(dist, 40);
            newCenterX = anchorX - (newWidth / 2) * ux;
            newCenterY = anchorY - (newWidth / 2) * uy;
          } else if (resizeTarget.handle === 'bottom') {
            const anchorX = tb.x - halfH * vx;
            const anchorY = tb.y - halfH * vy;
            const dist = (worldPoint.x - anchorX) * vx + (worldPoint.y - anchorY) * vy;
            newHeight = snapDim(dist, 24);
            newCenterX = anchorX + (newHeight / 2) * vx;
            newCenterY = anchorY + (newHeight / 2) * vy;
          } else if (resizeTarget.handle === 'top') {
            const anchorX = tb.x + halfH * vx;
            const anchorY = tb.y + halfH * vy;
            const dist = (anchorX - worldPoint.x) * vx + (anchorY - worldPoint.y) * vy;
            newHeight = snapDim(dist, 24);
            newCenterX = anchorX - (newHeight / 2) * vx;
            newCenterY = anchorY - (newHeight / 2) * vy;
          } else if (resizeTarget.handle === 'se') {
            const anchorX = tb.x - halfW * ux - halfH * vx;
            const anchorY = tb.y - halfW * uy - halfH * vy;
            const distX = (worldPoint.x - anchorX) * ux + (worldPoint.y - anchorY) * uy;
            const distY = (worldPoint.x - anchorX) * vx + (worldPoint.y - anchorY) * vy;
            newWidth = snapDim(distX, 40);
            newHeight = snapDim(distY, 24);
            newCenterX = anchorX + (newWidth / 2) * ux + (newHeight / 2) * vx;
            newCenterY = anchorY + (newWidth / 2) * uy + (newHeight / 2) * vy;
          } else if (resizeTarget.handle === 'sw') {
            const anchorX = tb.x + halfW * ux - halfH * vx;
            const anchorY = tb.y + halfW * uy - halfH * vy;
            const distX = (anchorX - worldPoint.x) * ux + (anchorY - worldPoint.y) * uy;
            const distY = (worldPoint.x - anchorX) * vx + (worldPoint.y - anchorY) * vy;
            newWidth = snapDim(distX, 40);
            newHeight = snapDim(distY, 24);
            newCenterX = anchorX - (newWidth / 2) * ux + (newHeight / 2) * vx;
            newCenterY = anchorY - (newWidth / 2) * uy + (newHeight / 2) * vy;
          } else if (resizeTarget.handle === 'ne') {
            const anchorX = tb.x - halfW * ux + halfH * vx;
            const anchorY = tb.y - halfW * uy + halfH * vy;
            const distX = (worldPoint.x - anchorX) * ux + (worldPoint.y - anchorY) * uy;
            const distY = (anchorX - worldPoint.x) * vx + (anchorY - worldPoint.y) * vy;
            newWidth = snapDim(distX, 40);
            newHeight = snapDim(distY, 24);
            newCenterX = anchorX + (newWidth / 2) * ux - (newHeight / 2) * vx;
            newCenterY = anchorY + (newWidth / 2) * uy - (newHeight / 2) * vy;
          } else if (resizeTarget.handle === 'nw') {
            const anchorX = tb.x + halfW * ux + halfH * vx;
            const anchorY = tb.y + halfW * uy + halfH * vy;
            const distX = (anchorX - worldPoint.x) * ux + (anchorY - worldPoint.y) * uy;
            const distY = (anchorX - worldPoint.x) * vx + (anchorY - worldPoint.y) * vy;
            newWidth = snapDim(distX, 40);
            newHeight = snapDim(distY, 24);
            newCenterX = anchorX - (newWidth / 2) * ux - (newHeight / 2) * vx;
            newCenterY = anchorY - (newWidth / 2) * uy - (newHeight / 2) * vy;
          }

          setState((prev) => ({
            ...prev,
            textBoxes: (prev.textBoxes || []).map((t) =>
              t.id === selectedId
                ? {
                    ...t,
                    x: Math.round(newCenterX),
                    y: Math.round(newCenterY),
                    width: Math.round(newWidth),
                    height: Math.round(newHeight),
                  }
                : t
            ),
          }));
        }
      } else if (resizeTarget.type === 'wall') {
        const wall = state.walls.find((w) => w.id === selectedId);
        if (wall) {
          const snappedPoint = snapPointToGrid(worldPoint, state.gridSize, state.gridSnap);
          if (resizeTarget.handle === 'start') {
            const finalStart = e.shiftKey
              ? snapAngle(wall.end, snappedPoint, state.gridSize, state.gridSnap)
              : snappedPoint;
            if (distance(finalStart, wall.end) >= 15) {
              setState((prev) => ({
                ...prev,
                walls: prev.walls.map((w) =>
                  w.id === selectedId ? { ...w, start: finalStart } : w
                ),
              }));
            }
          } else if (resizeTarget.handle === 'end') {
            const finalEnd = e.shiftKey
              ? snapAngle(wall.start, snappedPoint, state.gridSize, state.gridSnap)
              : snappedPoint;
            if (distance(wall.start, finalEnd) >= 15) {
              setState((prev) => ({
                ...prev,
                walls: prev.walls.map((w) =>
                  w.id === selectedId ? { ...w, end: finalEnd } : w
                ),
              }));
            }
          }
        }
      }
    }

    if (isDragging && !resizeTarget) {
      if (dragStartPoint && Object.keys(dragInitialPositions).length > 1) {
        let dx = worldPoint.x - dragStartPoint.x;
        let dy = worldPoint.y - dragStartPoint.y;
        if (state.gridSnap) {
          dx = Math.round(dx / state.gridSize) * state.gridSize;
          dy = Math.round(dy / state.gridSize) * state.gridSize;
        }
        setState((prev) => ({
          ...prev,
          furniture: prev.furniture.map((f) =>
            dragInitialPositions[f.id]
              ? { ...f, x: dragInitialPositions[f.id].x + dx, y: dragInitialPositions[f.id].y + dy }
              : f
          ),
          textBoxes: (prev.textBoxes || []).map((t) =>
            dragInitialPositions[t.id]
              ? { ...t, x: dragInitialPositions[t.id].x + dx, y: dragInitialPositions[t.id].y + dy }
              : t
          ),
          doors: prev.doors.map((d) =>
            dragInitialPositions[d.id]
              ? { ...d, x: dragInitialPositions[d.id].x + dx, y: dragInitialPositions[d.id].y + dy }
              : d
          ),
          windows: prev.windows.map((w) =>
            dragInitialPositions[w.id]
              ? { ...w, x: dragInitialPositions[w.id].x + dx, y: dragInitialPositions[w.id].y + dy }
              : w
          ),
          walls: prev.walls.map((wl) =>
            dragInitialPositions[wl.id]
              ? {
                  ...wl,
                  start: { x: dragInitialPositions[wl.id].x + dx, y: dragInitialPositions[wl.id].y + dy },
                  end: {
                    x: (dragInitialPositions[wl.id].endX ?? wl.end.x) + dx,
                    y: (dragInitialPositions[wl.id].endY ?? wl.end.y) + dy,
                  },
                }
              : wl
          ),
        }));
      } else if (selectedId) {
        if (selectedType === 'furniture') {
          const item = state.furniture.find((f) => f.id === selectedId);
          if (item) {
            let newX = worldPoint.x - dragOffset.x;
            let newY = worldPoint.y - dragOffset.y;
            if (state.gridSnap) {
              const isRotated90 = Math.abs(Math.round(item.rotation / 90) % 2) === 1;
              const effHalfW = isRotated90 ? item.depth / 2 : item.width / 2;
              const effHalfD = isRotated90 ? item.width / 2 : item.depth / 2;
              const left = Math.round((newX - effHalfW) / state.gridSize) * state.gridSize;
              const top = Math.round((newY - effHalfD) / state.gridSize) * state.gridSize;
              newX = left + effHalfW;
              newY = top + effHalfD;
            }
            setState((prev) => ({
              ...prev,
              furniture: prev.furniture.map((f) =>
                f.id === selectedId ? { ...f, x: newX, y: newY } : f
              ),
            }));
          }
        } else if (selectedType === 'door') {
          const item = state.doors.find((d) => d.id === selectedId);
          if (item) {
            let newX = worldPoint.x - dragOffset.x;
            let newY = worldPoint.y - dragOffset.y;
            if (state.gridSnap) {
              newX = Math.round(newX / (state.gridSize / 2)) * (state.gridSize / 2);
              newY = Math.round(newY / (state.gridSize / 2)) * (state.gridSize / 2);
            }
            setState((prev) => ({
              ...prev,
              doors: prev.doors.map((d) =>
                d.id === selectedId ? { ...d, x: newX, y: newY } : d
              ),
            }));
          }
        } else if (selectedType === 'window') {
          const item = state.windows.find((w) => w.id === selectedId);
          if (item) {
            let newX = worldPoint.x - dragOffset.x;
            let newY = worldPoint.y - dragOffset.y;
            if (state.gridSnap) {
              newX = Math.round(newX / (state.gridSize / 2)) * (state.gridSize / 2);
              newY = Math.round(newY / (state.gridSize / 2)) * (state.gridSize / 2);
            }
            setState((prev) => ({
              ...prev,
              windows: prev.windows.map((w) =>
                w.id === selectedId ? { ...w, x: newX, y: newY } : w
              ),
            }));
          }
        } else if (selectedType === 'textbox') {
          const item = (state.textBoxes || []).find((t) => t.id === selectedId);
          if (item) {
            let newX = worldPoint.x - dragOffset.x;
            let newY = worldPoint.y - dragOffset.y;
            if (state.gridSnap) {
              const isRotated90 = Math.abs(Math.round(item.rotation / 90) % 2) === 1;
              const effHalfW = isRotated90 ? item.height / 2 : item.width / 2;
              const effHalfH = isRotated90 ? item.width / 2 : item.height / 2;
              const left = Math.round((newX - effHalfW) / state.gridSize) * state.gridSize;
              const top = Math.round((newY - effHalfH) / state.gridSize) * state.gridSize;
              newX = left + effHalfW;
              newY = top + effHalfH;
            }
            setState((prev) => ({
              ...prev,
              textBoxes: (prev.textBoxes || []).map((t) =>
                t.id === selectedId ? { ...t, x: newX, y: newY } : t
              ),
            }));
          }
        } else if (selectedType === 'wall') {
          const wall = state.walls.find((w) => w.id === selectedId);
          if (wall) {
            const halfDx = (wall.end.x - wall.start.x) / 2;
            const halfDy = (wall.end.y - wall.start.y) / 2;
            const targetMidX = worldPoint.x - dragOffset.x;
            const targetMidY = worldPoint.y - dragOffset.y;

            let newStartX = targetMidX - halfDx;
            let newStartY = targetMidY - halfDy;

            if (state.gridSnap) {
              newStartX = Math.round(newStartX / state.gridSize) * state.gridSize;
              newStartY = Math.round(newStartY / state.gridSize) * state.gridSize;
            } else {
              newStartX = Math.round(newStartX);
              newStartY = Math.round(newStartY);
            }

            const newEndX = newStartX + (wall.end.x - wall.start.x);
            const newEndY = newStartY + (wall.end.y - wall.start.y);

            setState((prev) => ({
              ...prev,
              walls: prev.walls.map((w) =>
                w.id === selectedId
                  ? {
                      ...w,
                      start: { x: newStartX, y: newStartY },
                      end: { x: newEndX, y: newEndY },
                    }
                  : w
              ),
            }));
          }
        }
      }
    }

    if (isRotating && selectedId) {
      let center: Point | null = null;
      if (selectedType === 'furniture') {
        const item = state.furniture.find((f) => f.id === selectedId);
        if (item) center = { x: item.x, y: item.y };
      } else if (selectedType === 'door') {
        const item = state.doors.find((d) => d.id === selectedId);
        if (item) center = { x: item.x, y: item.y };
      } else if (selectedType === 'window') {
        const item = state.windows.find((w) => w.id === selectedId);
        if (item) center = { x: item.x, y: item.y };
      } else if (selectedType === 'textbox') {
        const item = (state.textBoxes || []).find((t) => t.id === selectedId);
        if (item) center = { x: item.x, y: item.y };
      } else if (selectedType === 'wall') {
        const item = state.walls.find((w) => w.id === selectedId);
        if (item) center = { x: (item.start.x + item.end.x) / 2, y: (item.start.y + item.end.y) / 2 };
      }

      if (center) {
        const dx = worldPoint.x - center.x;
        const dy = worldPoint.y - center.y;
        let angleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90);
        if (angleDeg < 0) angleDeg += 360;

        if (e.shiftKey) {
          angleDeg = Math.round(angleDeg / 45) * 45;
        }

        const rot = angleDeg % 360;

        if (selectedType === 'furniture') {
          setState((prev) => ({
            ...prev,
            furniture: prev.furniture.map((f) =>
              f.id === selectedId ? { ...f, rotation: rot } : f
            ),
          }));
        } else if (selectedType === 'door') {
          setState((prev) => ({
            ...prev,
            doors: prev.doors.map((d) =>
              d.id === selectedId ? { ...d, rotation: rot } : d
            ),
          }));
        } else if (selectedType === 'window') {
          setState((prev) => ({
            ...prev,
            windows: prev.windows.map((w) =>
              w.id === selectedId ? { ...w, rotation: rot } : w
            ),
          }));
        } else if (selectedType === 'textbox') {
          setState((prev) => ({
            ...prev,
            textBoxes: (prev.textBoxes || []).map((t) =>
              t.id === selectedId ? { ...t, rotation: rot } : t
            ),
          }));
        } else if (selectedType === 'wall') {
          const wall = state.walls.find((w) => w.id === selectedId);
          if (wall) {
            const len = distance(wall.start, wall.end);
            const half = len / 2;
            // Wall axis is perpendicular to handle vector
            const handleAngleRad = Math.atan2(dy, dx);
            let wallAngleRad = handleAngleRad + Math.PI / 2;
            if (e.shiftKey) {
              const snapInc = Math.PI / 4;
              wallAngleRad = Math.round(wallAngleRad / snapInc) * snapInc;
            }
            const cos = Math.cos(wallAngleRad);
            const sin = Math.sin(wallAngleRad);
            let newStart = {
              x: Math.round(center.x - half * cos),
              y: Math.round(center.y - half * sin),
            };
            let newEnd = {
              x: Math.round(center.x + half * cos),
              y: Math.round(center.y + half * sin),
            };
            if (state.gridSnap) {
              if (Math.abs(sin) < 1e-4) {
                newStart.y = Math.round(newStart.y / state.gridSize) * state.gridSize;
                newEnd.y = newStart.y;
                newStart.x = Math.round(newStart.x / state.gridSize) * state.gridSize;
                newEnd.x = Math.round(newEnd.x / state.gridSize) * state.gridSize;
              } else if (Math.abs(cos) < 1e-4) {
                newStart.x = Math.round(newStart.x / state.gridSize) * state.gridSize;
                newEnd.x = newStart.x;
                newStart.y = Math.round(newStart.y / state.gridSize) * state.gridSize;
                newEnd.y = Math.round(newEnd.y / state.gridSize) * state.gridSize;
              }
            }
            setState((prev) => ({
              ...prev,
              walls: prev.walls.map((w) =>
                w.id === selectedId ? { ...w, start: newStart, end: newEnd } : w
              ),
            }));
          }
        }
      }
    }
  };

  const handlePointerUp = (e?: React.PointerEvent | PointerEvent) => {
    if (isDragging || resizeTarget || isRotating || selectionBox) {
      onEndInteraction?.();
    }
    setIsPanning(false);
    setIsDragging(false);
    setIsRotating(false);
    setResizeTarget(null);
    setDragStartPoint(null);
    setDragInitialPositions({});

    if (selectionBox) {
      const minX = Math.min(selectionBox.start.x, selectionBox.current.x);
      const maxX = Math.max(selectionBox.start.x, selectionBox.current.x);
      const minY = Math.min(selectionBox.start.y, selectionBox.current.y);
      const maxY = Math.max(selectionBox.start.y, selectionBox.current.y);
      const w = maxX - minX;
      const h = maxY - minY;

      if (w >= 5 || h >= 5) {
        const boxed: { id: string; type: SelectedElementType }[] = [];

        for (const f of state.furniture) {
          const hw = f.width / 2;
          const hd = f.depth / 2;
          if (f.x + hw >= minX && f.x - hw <= maxX && f.y + hd >= minY && f.y - hd <= maxY) {
            boxed.push({ id: f.id, type: 'furniture' });
          }
        }

        for (const t of state.textBoxes || []) {
          const hw = t.width / 2;
          const hh = t.height / 2;
          if (t.x + hw >= minX && t.x - hw <= maxX && t.y + hh >= minY && t.y - hh <= maxY) {
            boxed.push({ id: t.id, type: 'textbox' });
          }
        }

        for (const d of state.doors) {
          const hw = d.width / 2;
          if (d.x + hw >= minX && d.x - hw <= maxX && d.y + hw >= minY && d.y - hw <= maxY) {
            boxed.push({ id: d.id, type: 'door' });
          }
        }

        for (const win of state.windows) {
          const hw = win.width / 2;
          const hh = (win.thickness || 15) / 2;
          if (win.x + hw >= minX && win.x - hw <= maxX && win.y + hh >= minY && win.y - hh <= maxY) {
            boxed.push({ id: win.id, type: 'window' });
          }
        }

        for (const wl of state.walls) {
          const wMinX = Math.min(wl.start.x, wl.end.x);
          const wMaxX = Math.max(wl.start.x, wl.end.x);
          const wMinY = Math.min(wl.start.y, wl.end.y);
          const wMaxY = Math.max(wl.start.y, wl.end.y);
          if (wMaxX >= minX && wMinX <= maxX && wMaxY >= minY && wMinY <= maxY) {
            boxed.push({ id: wl.id, type: 'wall' });
          }
        }

        for (const m of state.measurements) {
          const mMinX = Math.min(m.start.x, m.end.x);
          const mMaxX = Math.max(m.start.x, m.end.x);
          const mMinY = Math.min(m.start.y, m.end.y);
          const mMaxY = Math.max(m.start.y, m.end.y);
          if (mMaxX >= minX && mMinX <= maxX && mMaxY >= minY && mMinY <= maxY) {
            boxed.push({ id: m.id, type: 'measurement' });
          }
        }

        const boxedIds = boxed.map((b) => b.id);
        const isShift = Boolean(e && e.shiftKey);
        let ids: string[];
        if (isShift) {
          ids = Array.from(new Set([...selectedIds, ...boxedIds]));
        } else {
          ids = boxedIds;
        }

        if (ids.length === 1) {
          const singleItem = boxed.find((b) => b.id === ids[0]);
          setSelectedId(ids[0]);
          setSelectedType(singleItem ? singleItem.type : 'furniture');
          setSelectedIds?.(ids);
        } else if (ids.length > 1) {
          setSelectedId(ids[0]);
          setSelectedType('multiple');
          setSelectedIds?.(ids);
        } else {
          if (!isShift) {
            setSelectedId(null);
            setSelectedType(null);
            setSelectedIds?.([]);
          }
        }
      }
      setSelectionBox(null);
    }

    if (tool === 'wall' && wallStart && wallCurrent) {
      const dist = distance(wallStart, wallCurrent);
      if (dist >= 15) {
        const newWall: Wall = {
          id: 'wall_' + Date.now(),
          start: wallStart,
          end: wallCurrent,
          thickness: 15,
        };
        setState((prev) => ({ ...prev, walls: [...prev.walls, newWall] }));
        setWallStart(null);
        setWallCurrent(null);
        setTool('select');
        setSelectedId(newWall.id);
        setSelectedType('wall');
      }
    }

    if (tool === 'door' && doorStart && doorCurrent) {
      const dist = distance(doorStart, doorCurrent);
      if (dist >= 30) {
        const mid = { x: (doorStart.x + doorCurrent.x) / 2, y: (doorStart.y + doorCurrent.y) / 2 };
        const angleRad = Math.atan2(doorCurrent.y - doorStart.y, doorCurrent.x - doorStart.x);
        const angleDeg = Math.round((angleRad * 180) / Math.PI);
        const newDoor: Door = {
          id: 'door_' + Date.now(),
          x: Math.round(mid.x),
          y: Math.round(mid.y),
          width: Math.round(dist),
          rotation: (angleDeg + 360) % 360,
          swingDirection: 'left',
        };
        setState((prev) => ({ ...prev, doors: [...prev.doors, newDoor] }));
        setDoorStart(null);
        setDoorCurrent(null);
        setTool('select');
        setSelectedId(newDoor.id);
        setSelectedType('door');
      }
    }

    if (tool === 'window' && windowStart && windowCurrent) {
      const dist = distance(windowStart, windowCurrent);
      if (dist >= 30) {
        const mid = { x: (windowStart.x + windowCurrent.x) / 2, y: (windowStart.y + windowCurrent.y) / 2 };
        const angleRad = Math.atan2(windowCurrent.y - windowStart.y, windowCurrent.x - windowStart.x);
        const angleDeg = Math.round((angleRad * 180) / Math.PI);
        const newWin: WindowItem = {
          id: 'win_' + Date.now(),
          x: Math.round(mid.x),
          y: Math.round(mid.y),
          width: Math.round(dist),
          thickness: 15,
          rotation: (angleDeg + 360) % 360,
        };
        setState((prev) => ({ ...prev, windows: [...prev.windows, newWin] }));
        setWindowStart(null);
        setWindowCurrent(null);
        setTool('select');
        setSelectedId(newWin.id);
        setSelectedType('window');
      }
    }
  };

  const handleApplyCalibration = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingCalibDistCm) return;
    const val = parseFloat(calibInputValue);
    if (!isNaN(val) && val > 0) {
      const targetCm = state.unit === 'm' ? val * 100 : val * 30.48;
      const ratio = targetCm / pendingCalibDistCm;
      setState((prev) => rescaleFloorplanState(prev, ratio));
    }
    setPendingCalibDistCm(null);
    setTool('select');
  };

  const handlePointerMoveRef = useRef(handlePointerMove);
  handlePointerMoveRef.current = handlePointerMove;
  const handlePointerUpRef = useRef(handlePointerUp);
  handlePointerUpRef.current = handlePointerUp;

  useEffect(() => {
    if (!isDragging && !resizeTarget && !isRotating && !isPanning && !selectionBox) return;
    const onWindowPointerMove = (e: PointerEvent) => {
      handlePointerMoveRef.current(e as unknown as React.PointerEvent);
    };
    const onWindowPointerUp = () => {
      handlePointerUpRef.current();
    };
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
  }, [isDragging, resizeTarget, isRotating, isPanning, selectionBox]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.code === 'Space' && !e.repeat) {
        setIsSpacePressed(true);
      } else if (e.key === 'Escape') {
        setWallStart(null);
        setWallCurrent(null);
        setDoorStart(null);
        setDoorCurrent(null);
        setWindowStart(null);
        setWindowCurrent(null);
        setMeasureStart(null);
        setMeasureEnd(null);
        setCalibStart(null);
        setCalibEnd(null);
        setPendingCalibDistCm(null);
        setSelectionBox(null);
        setSelectedId(null);
        setSelectedType(null);
        setSelectedIds?.([]);
        setTool('select');
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        (selectedId || (selectedIds && selectedIds.length > 0))
      ) {
        const idsToDelete = new Set(
          selectedIds && selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : []
        );
        setState((prev) => ({
          ...prev,
          furniture: prev.furniture.filter((f) => !idsToDelete.has(f.id)),
          walls: prev.walls.filter((w) => !idsToDelete.has(w.id)),
          doors: prev.doors.filter((d) => !idsToDelete.has(d.id)),
          windows: prev.windows.filter((w) => !idsToDelete.has(w.id)),
          measurements: prev.measurements.filter((m) => !idsToDelete.has(m.id)),
          textBoxes: (prev.textBoxes || []).filter((t) => !idsToDelete.has(t.id)),
        }));
        setSelectedId(null);
        setSelectedType(null);
        setSelectedIds?.([]);
      } else if (!e.metaKey && !e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (e.shiftKey && key === 'w') {
          setTool('wall');
        } else if (e.shiftKey && key === 'd') {
          setTool('door');
        } else if (key === 'w' || e.key === 'ArrowUp') {
          e.preventDefault();
          setPan((p) => ({ ...p, y: p.y + 40 }));
        } else if (key === 's' || e.key === 'ArrowDown') {
          e.preventDefault();
          setPan((p) => ({ ...p, y: p.y - 40 }));
        } else if (key === 'a' || e.key === 'ArrowLeft') {
          e.preventDefault();
          setPan((p) => ({ ...p, x: p.x + 40 }));
        } else if (key === 'd' || e.key === 'ArrowRight') {
          e.preventDefault();
          setPan((p) => ({ ...p, x: p.x - 40 }));
        } else if (key === '1' || key === 'v') {
          setTool('select');
        } else if (key === '2') {
          setTool('wall');
        } else if (key === '3') {
          setTool('door');
        } else if (key === '4') {
          setTool('window');
        } else if (key === '5' || key === 't') {
          setTool('text');
        } else if (key === '6' || key === 'm') {
          setTool('measure');
        } else if (key === '7' || key === 'h') {
          setTool('pan');
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [selectedId, selectedIds, selectedType, setState, setSelectedId, setSelectedIds, setSelectedType, setTool, setPan]);

  const toggleOrSelectItem = (clickedId: string, type: SelectedElementType, isShift: boolean) => {
    if (isShift) {
      const exists = selectedIds.includes(clickedId);
      const next = exists ? selectedIds.filter((id) => id !== clickedId) : [...selectedIds, clickedId];
      setSelectedIds?.(next);
      setSelectedId(next[next.length - 1] || null);
      setSelectedType(next.length > 1 ? 'multiple' : next.length === 1 ? type : null);
    } else {
      setSelectedId(clickedId);
      setSelectedType(type);
      setSelectedIds?.([clickedId]);
    }
  };

  const startDragForIds = (clickedId: string, type: SelectedElementType, worldPoint: Point, itemPos: Point) => {
    const isAlreadyInSelection = selectedIds.includes(clickedId);
    const activeIds = isAlreadyInSelection && selectedIds.length > 1 ? selectedIds : [clickedId];
    if (!isAlreadyInSelection) {
      setSelectedId(clickedId);
      setSelectedType(type);
      setSelectedIds?.([clickedId]);
    }
    setIsDragging(true);
    onStartInteraction?.();
    if (activeIds.length > 1) {
      const initPos: { [id: string]: Point & { endX?: number; endY?: number } } = {};
      for (const f of state.furniture) if (activeIds.includes(f.id)) initPos[f.id] = { x: f.x, y: f.y };
      for (const t of state.textBoxes || []) if (activeIds.includes(t.id)) initPos[t.id] = { x: t.x, y: t.y };
      for (const d of state.doors) if (activeIds.includes(d.id)) initPos[d.id] = { x: d.x, y: d.y };
      for (const w of state.windows) if (activeIds.includes(w.id)) initPos[w.id] = { x: w.x, y: w.y };
      for (const wl of state.walls) if (activeIds.includes(wl.id)) initPos[wl.id] = { x: wl.start.x, y: wl.start.y, endX: wl.end.x, endY: wl.end.y };
      setDragInitialPositions(initPos);
      setDragStartPoint(worldPoint);
    } else {
      setDragOffset({ x: worldPoint.x - itemPos.x, y: worldPoint.y - itemPos.y });
    }
  };

  const selectedWall = selectedType === 'wall' ? state.walls.find((w) => w.id === selectedId) : null;
  const selectedFurniture = selectedType === 'furniture' ? state.furniture.find((f) => f.id === selectedId) : null;
  const selectedDoor = selectedType === 'door' ? state.doors.find((d) => d.id === selectedId) : null;
  const selectedWindow = selectedType === 'window' ? state.windows.find((w) => w.id === selectedId) : null;
  const selectedTextBox = selectedType === 'textbox' ? (state.textBoxes || []).find((t) => t.id === selectedId) : null;

  const canvasCursorClass =
    isPanning || isSpacePressed
      ? isPanning
        ? 'cursor-grabbing'
        : 'cursor-grab'
      : tool === 'pan'
      ? isPanning
        ? 'cursor-grabbing'
        : 'cursor-grab'
      : tool === 'wall' || tool === 'door' || tool === 'window' || tool === 'measure' || tool === 'calibrate'
      ? 'cursor-crosshair'
      : tool === 'text'
      ? 'cursor-text'
      : '';

  return (
    <div className="canvas-wrapper">
      <svg
        ref={svgRef}
        id="floorplan-svg"
        className={`floorplan-svg ${canvasCursorClass}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <defs>
          <pattern
            id="minorGrid"
            width={state.gridSize}
            height={state.gridSize}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${state.gridSize} 0 L 0 0 0 ${state.gridSize}`}
              fill="none"
              stroke="#e2e8f0"
              strokeWidth="0.8"
            />
          </pattern>
          <pattern id="majorGrid" width="100" height="100" patternUnits="userSpaceOnUse">
            <rect width="100" height="100" fill="url(#minorGrid)" />
            <path d="M 100 0 L 0 0 0 100" fill="none" stroke="#cbd5e1" strokeWidth="1.5" />
          </pattern>
        </defs>

        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#majorGrid)" />

          {state.background && state.background.visible && (
            <image
              href={state.background.dataUrl}
              x={state.background.x}
              y={state.background.y}
              width={state.background.width}
              height={state.background.height}
              opacity={state.background.opacity}
              preserveAspectRatio="none"
              style={{ pointerEvents: 'none' }}
            />
          )}

          <line x1="-30" y1="0" x2="30" y2="0" stroke="#94a3b8" strokeWidth="1.5" />
          <line x1="0" y1="-30" x2="0" y2="30" stroke="#94a3b8" strokeWidth="1.5" />
          <text x="8" y="-8" fontSize="11" fill="#94a3b8" fontFamily="sans-serif">
            (0, 0)
          </text>

          {state.walls.map((wall) => {
            const isSelected = selectedId === wall.id || selectedIds.includes(wall.id);
            const wallLength = distance(wall.start, wall.end);
            const midX = (wall.start.x + wall.end.x) / 2;
            const midY = (wall.start.y + wall.end.y) / 2;

            return (
              <g
                key={wall.id}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOrSelectItem(wall.id, 'wall', e.shiftKey);
                }}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    if (e.shiftKey) {
                      toggleOrSelectItem(wall.id, 'wall', true);
                      return;
                    }
                    const worldPoint = screenToWorld(e.clientX, e.clientY);
                    startDragForIds(wall.id, 'wall', worldPoint, { x: midX, y: midY });
                  }
                }}
                className={tool === 'select' ? 'cursor-move' : 'cursor-pointer'}
              >
                <line
                  x1={wall.start.x}
                  y1={wall.start.y}
                  x2={wall.end.x}
                  y2={wall.end.y}
                  stroke="transparent"
                  strokeWidth={Math.max(wall.thickness + 14, 26)}
                />
                <line
                  x1={wall.start.x}
                  y1={wall.start.y}
                  x2={wall.end.x}
                  y2={wall.end.y}
                  stroke={isSelected ? '#3b82f6' : '#1e293b'}
                  strokeWidth={wall.thickness}
                  strokeLinecap="square"
                />
                <line
                  x1={wall.start.x}
                  y1={wall.start.y}
                  x2={wall.end.x}
                  y2={wall.end.y}
                  stroke={isSelected ? '#93c5fd' : '#475569'}
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                <g transform={`translate(${midX}, ${midY})`}>
                  <rect
                    x="-28"
                    y="-10"
                    width="56"
                    height="18"
                    rx="4"
                    fill="#ffffff"
                    stroke="#94a3b8"
                    strokeWidth="0.8"
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="10"
                    fontWeight="600"
                    fill="#1e293b"
                    fontFamily="monospace"
                  >
                    {formatDimension(wallLength, state.unit)}
                  </text>
                </g>
              </g>
            );
          })}

          {wallStart && wallCurrent && (
            <g>
              <line
                x1={wallStart.x}
                y1={wallStart.y}
                x2={wallCurrent.x}
                y2={wallCurrent.y}
                stroke="#2563eb"
                strokeWidth="15"
                strokeDasharray="6 4"
                strokeLinecap="square"
                opacity="0.8"
              />
              <circle cx={wallStart.x} cy={wallStart.y} r="5" fill="#2563eb" />
              <circle cx={wallCurrent.x} cy={wallCurrent.y} r="5" fill="#2563eb" />
              <g
                transform={`translate(${(wallStart.x + wallCurrent.x) / 2}, ${
                  (wallStart.y + wallCurrent.y) / 2
                })`}
              >
                <rect
                  x="-32"
                  y="-12"
                  width="64"
                  height="22"
                  rx="4"
                  fill="#1e293b"
                  fillOpacity="0.9"
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="11"
                  fontWeight="bold"
                  fill="#ffffff"
                  fontFamily="monospace"
                >
                  {formatDimension(distance(wallStart, wallCurrent), state.unit)}
                </text>
              </g>
            </g>
          )}

          {doorStart && doorCurrent && (
            <g>
              <line
                x1={doorStart.x}
                y1={doorStart.y}
                x2={doorCurrent.x}
                y2={doorCurrent.y}
                stroke="#78350f"
                strokeWidth="6"
                strokeLinecap="square"
              />
              <circle cx={doorStart.x} cy={doorStart.y} r="5" fill="#78350f" />
              <circle cx={doorCurrent.x} cy={doorCurrent.y} r="5" fill="#78350f" />
              {(() => {
                const dist = distance(doorStart, doorCurrent);
                const angleRad = Math.atan2(doorCurrent.y - doorStart.y, doorCurrent.x - doorStart.x);
                const angleDeg = (angleRad * 180) / Math.PI;
                const midX = (doorStart.x + doorCurrent.x) / 2;
                const midY = (doorStart.y + doorCurrent.y) / 2;
                return (
                  <g transform={`translate(${midX}, ${midY}) rotate(${angleDeg})`}>
                    <path
                      d={`M ${dist / 2} 0 A ${dist} ${dist} 0 0 1 ${-dist / 2} ${dist}`}
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                      strokeDasharray="4 3"
                    />
                    <line x1={-dist / 2} y1="0" x2={-dist / 2} y2={dist} stroke="#78350f" strokeWidth="3.5" />
                    <g transform={`translate(0, -18)`}>
                      <rect x="-34" y="-11" width="68" height="22" rx="4" fill="#1e293b" fillOpacity="0.9" />
                      <text textAnchor="middle" dominantBaseline="central" fontSize="11" fontWeight="bold" fill="#ffffff" fontFamily="monospace">
                        {formatDimension(dist, state.unit)}
                      </text>
                    </g>
                  </g>
                );
              })()}
            </g>
          )}

          {windowStart && windowCurrent && (
            <g>
              {(() => {
                const dist = distance(windowStart, windowCurrent);
                const angleRad = Math.atan2(windowCurrent.y - windowStart.y, windowCurrent.x - windowStart.x);
                const angleDeg = (angleRad * 180) / Math.PI;
                const midX = (windowStart.x + windowCurrent.x) / 2;
                const midY = (windowStart.y + windowCurrent.y) / 2;
                return (
                  <g transform={`translate(${midX}, ${midY}) rotate(${angleDeg})`}>
                    <rect x={-dist / 2} y="-8" width={dist} height="16" fill="#ffffff" stroke="#0284c7" strokeWidth="2" />
                    <line x1={-dist / 2} y1="-3" x2={dist / 2} y2="-3" stroke="#38bdf8" strokeWidth="2" />
                    <line x1={-dist / 2} y1="3" x2={dist / 2} y2="3" stroke="#38bdf8" strokeWidth="2" />
                    <g transform={`translate(0, -18)`}>
                      <rect x="-34" y="-11" width="68" height="22" rx="4" fill="#1e293b" fillOpacity="0.9" />
                      <text textAnchor="middle" dominantBaseline="central" fontSize="11" fontWeight="bold" fill="#ffffff" fontFamily="monospace">
                        {formatDimension(dist, state.unit)}
                      </text>
                    </g>
                  </g>
                );
              })()}
              <circle cx={windowStart.x} cy={windowStart.y} r="5" fill="#0284c7" />
              <circle cx={windowCurrent.x} cy={windowCurrent.y} r="5" fill="#0284c7" />
            </g>
          )}

          {state.doors.map((door) => {
            const isSelected = selectedId === door.id || selectedIds.includes(door.id);
            const halfW = door.width / 2;
            const isLeft = door.swingDirection !== 'right';

            return (
              <g
                key={door.id}
                transform={`translate(${door.x}, ${door.y}) rotate(${door.rotation})`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOrSelectItem(door.id, 'door', e.shiftKey);
                }}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    if (e.shiftKey) {
                      toggleOrSelectItem(door.id, 'door', true);
                      return;
                    }
                    const worldPoint = screenToWorld(e.clientX, e.clientY);
                    startDragForIds(door.id, 'door', worldPoint, { x: door.x, y: door.y });
                  }
                }}
                className="cursor-move"
              >
                <rect
                  x={-halfW}
                  y="-10"
                  width={door.width}
                  height="20"
                  fill="#ffffff"
                  stroke={isSelected ? '#2563eb' : '#94a3b8'}
                  strokeWidth={isSelected ? '2' : '1'}
                />

                <rect x={-halfW} y="-10" width="5" height="20" fill="#334155" />
                <rect x={halfW - 5} y="-10" width="5" height="20" fill="#334155" />

                {isLeft ? (
                  <>
                    <path
                      d={`M ${halfW} 0 A ${door.width} ${door.width} 0 0 1 ${-halfW} ${door.width}`}
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                      strokeDasharray="4 3"
                    />
                    <line
                      x1={-halfW}
                      y1="0"
                      x2={-halfW}
                      y2={door.width}
                      stroke="#78350f"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                    <circle cx={-halfW} cy="0" r="3" fill="#78350f" />
                  </>
                ) : (
                  <>
                    <path
                      d={`M ${-halfW} 0 A ${door.width} ${door.width} 0 0 0 ${halfW} ${door.width}`}
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                      strokeDasharray="4 3"
                    />
                    <line
                      x1={halfW}
                      y1="0"
                      x2={halfW}
                      y2={door.width}
                      stroke="#78350f"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                    <circle cx={halfW} cy="0" r="3" fill="#78350f" />
                  </>
                )}
              </g>
            );
          })}

          {state.windows.map((win) => {
            const isSelected = selectedId === win.id || selectedIds.includes(win.id);
            const halfW = win.width / 2;
            const halfT = win.thickness / 2;

            return (
              <g
                key={win.id}
                transform={`translate(${win.x}, ${win.y}) rotate(${win.rotation})`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOrSelectItem(win.id, 'window', e.shiftKey);
                }}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    if (e.shiftKey) {
                      toggleOrSelectItem(win.id, 'window', true);
                      return;
                    }
                    const worldPoint = screenToWorld(e.clientX, e.clientY);
                    startDragForIds(win.id, 'window', worldPoint, { x: win.x, y: win.y });
                  }
                }}
                className="cursor-move"
              >
                <rect
                  x={-halfW}
                  y={-halfT}
                  width={win.width}
                  height={win.thickness}
                  fill="#ffffff"
                  stroke={isSelected ? '#2563eb' : '#64748b'}
                  strokeWidth={isSelected ? '2' : '1.5'}
                />
                <line x1={-halfW} y1={-halfT} x2={-halfW} y2={halfT} stroke="#334155" strokeWidth="3" />
                <line x1={halfW} y1={-halfT} x2={halfW} y2={halfT} stroke="#334155" strokeWidth="3" />
                <line
                  x1={-halfW + 3}
                  y1={-halfT / 3}
                  x2={halfW - 3}
                  y2={-halfT / 3}
                  stroke="#0284c7"
                  strokeWidth="2"
                />
                <line
                  x1={-halfW + 3}
                  y1={halfT / 3}
                  x2={halfW - 3}
                  y2={halfT / 3}
                  stroke="#0284c7"
                  strokeWidth="2"
                />
              </g>
            );
          })}

          {state.furniture.map((item) => {
            const isSelected = selectedId === item.id || selectedIds.includes(item.id);
            const halfW = item.width / 2;
            const halfD = item.depth / 2;

            return (
              <g
                key={item.id}
                transform={`translate(${item.x}, ${item.y}) rotate(${item.rotation})`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOrSelectItem(item.id, 'furniture', e.shiftKey);
                }}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    if (e.shiftKey) {
                      toggleOrSelectItem(item.id, 'furniture', true);
                      return;
                    }
                    const worldPoint = screenToWorld(e.clientX, e.clientY);
                    startDragForIds(item.id, 'furniture', worldPoint, { x: item.x, y: item.y });
                  }
                }}
                className="cursor-move"
              >
                {item.shape && (
                  <ShapeBody
                    shape={item.shape}
                    points={item.points}
                    width={item.width}
                    depth={item.depth}
                    fill={item.color}
                    stroke={isSelected ? '#2563eb' : '#0f172a'}
                    strokeWidth={isSelected ? 3 : 1.5}
                  />
                )}

                {!item.shape && item.iconType !== 'chair_office' && item.iconType !== 'dining_chair' && (
                  <rect
                    x={-halfW}
                    y={-halfD}
                    width={item.width}
                    height={item.depth}
                    rx={item.iconType === 'table_round' ? halfW : item.iconType === 'armchair' ? 4 : 0}
                    fill={item.color}
                    fillOpacity="0.88"
                    stroke={isSelected ? '#2563eb' : '#0f172a'}
                    strokeWidth={isSelected ? '3' : '1.5'}
                  />
                )}

                {(item.iconType === 'sofa' || item.iconType === 'sofa_2') && (
                  <g>
                    <rect
                      x={-halfW + 6}
                      y={-halfD + 4}
                      width={item.width - 12}
                      height={item.depth * 0.28}
                      rx="4"
                      fill="#0f172a"
                      fillOpacity="0.18"
                    />
                    <rect
                      x={-halfW + 4}
                      y={-halfD + 6}
                      width={item.width * 0.12}
                      height={item.depth - 12}
                      rx="3"
                      fill="#0f172a"
                      fillOpacity="0.22"
                    />
                    <rect
                      x={halfW - item.width * 0.12 - 4}
                      y={-halfD + 6}
                      width={item.width * 0.12}
                      height={item.depth - 12}
                      rx="3"
                      fill="#0f172a"
                      fillOpacity="0.22"
                    />
                  </g>
                )}

                {(item.iconType === 'bed_double' || item.iconType === 'bed_single') && (
                  <g>
                    <rect
                      x={-halfW + 4}
                      y={-halfD + 2}
                      width={item.width - 8}
                      height="18"
                      rx="2"
                      fill="#1e1b4b"
                      fillOpacity="0.3"
                    />
                    {item.iconType === 'bed_double' ? (
                      <>
                        <rect
                          x={-halfW + 12}
                          y={-halfD + 24}
                          width={halfW - 20}
                          height="36"
                          rx="4"
                          fill="#ffffff"
                          stroke="#cbd5e1"
                          strokeWidth="1"
                        />
                        <rect
                          x="8"
                          y={-halfD + 24}
                          width={halfW - 20}
                          height="36"
                          rx="4"
                          fill="#ffffff"
                          stroke="#cbd5e1"
                          strokeWidth="1"
                        />
                      </>
                    ) : (
                      <rect
                        x={-halfW + 16}
                        y={-halfD + 24}
                        width={item.width - 32}
                        height="36"
                        rx="4"
                        fill="#ffffff"
                        stroke="#cbd5e1"
                        strokeWidth="1"
                      />
                    )}
                    <line
                      x1={-halfW + 6}
                      y1="0"
                      x2={halfW - 6}
                      y2="0"
                      stroke="#ffffff"
                      strokeWidth="2"
                      strokeDasharray="4 2"
                    />
                  </g>
                )}

                {item.iconType === 'dining_set' && (
                  <g>
                    <rect
                      x={-halfW + 16}
                      y={-halfD + 12}
                      width={item.width - 32}
                      height={item.depth - 24}
                      rx="4"
                      fill="#ffffff"
                      fillOpacity="0.3"
                    />
                  </g>
                )}

                {item.iconType === 'desk' && (
                  <g>
                    <rect
                      x="-25"
                      y={-halfD + 8}
                      width="50"
                      height="10"
                      rx="2"
                      fill="#0f172a"
                    />
                    <rect
                      x="-18"
                      y={-halfD + 24}
                      width="36"
                      height="12"
                      rx="1"
                      fill="#ffffff"
                      fillOpacity="0.4"
                    />
                  </g>
                )}

                {item.iconType === 'armchair' && (
                  <g>
                    <rect
                      x={-halfW + 12}
                      y={-halfD + 5}
                      width={item.width - 24}
                      height={20}
                      rx="5"
                      fill="#0f172a"
                      fillOpacity="0.22"
                    />
                    <rect
                      x={-halfW + 4}
                      y={-halfD + 6}
                      width={14}
                      height={item.depth - 12}
                      rx="4"
                      fill="#0f172a"
                      fillOpacity="0.25"
                    />
                    <rect
                      x={halfW - 18}
                      y={-halfD + 6}
                      width={14}
                      height={item.depth - 12}
                      rx="4"
                      fill="#0f172a"
                      fillOpacity="0.25"
                    />
                    <rect
                      x={-halfW + 20}
                      y={-halfD + 27}
                      width={item.width - 40}
                      height={item.depth - 34}
                      rx="5"
                      fill="#ffffff"
                      fillOpacity="0.18"
                      stroke="#0f172a"
                      strokeWidth="1"
                      strokeOpacity="0.2"
                    />
                  </g>
                )}

                {item.iconType === 'chair_office' && (
                  <g>
                    <rect
                      x={-halfW}
                      y={-halfD}
                      width={item.width}
                      height={item.depth}
                      fill="transparent"
                    />
                    {[0, 72, 144, 216, 288].map((deg, i) => {
                      const rad = ((deg - 90) * Math.PI) / 180;
                      const r = 26;
                      const x2 = Math.cos(rad) * r;
                      const y2 = Math.sin(rad) * r + 2;
                      return (
                        <g key={i}>
                          <line
                            x1="0"
                            y1="2"
                            x2={x2}
                            y2={y2}
                            stroke="#64748b"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          />
                          <circle cx={x2} cy={y2} r="2.5" fill="#334155" />
                        </g>
                      );
                    })}
                    <circle cx="0" cy="2" r="4.5" fill="#1e293b" />
                    <rect
                      x="-20"
                      y="-12"
                      width="40"
                      height="34"
                      rx="7"
                      fill={item.color}
                      stroke={isSelected ? '#2563eb' : '#0f172a'}
                      strokeWidth="1.5"
                    />
                    <line x1="0" y1="-16" x2="0" y2="-12" stroke="#0f172a" strokeWidth="3" />
                    <rect
                      x="-19"
                      y="-27"
                      width="38"
                      height="11"
                      rx="5"
                      fill={item.color}
                      stroke={isSelected ? '#2563eb' : '#0f172a'}
                      strokeWidth="1.5"
                    />
                    <rect x="-26" y="-8" width="5" height="18" rx="2" fill="#1e293b" />
                    <rect x="21" y="-8" width="5" height="18" rx="2" fill="#1e293b" />
                  </g>
                )}

                {item.iconType === 'dining_chair' && (
                  <g>
                    <rect
                      x={-halfW}
                      y={-halfD}
                      width={item.width}
                      height={item.depth}
                      fill="transparent"
                    />
                    <path
                      d={`M ${-halfW + 4} ${-halfD + 10}
                          L ${halfW - 4} ${-halfD + 10}
                          L ${halfW - 2} ${halfD - 5}
                          Q ${halfW - 2} ${halfD} ${halfW - 7} ${halfD}
                          L ${-halfW + 7} ${halfD}
                          Q ${-halfW + 2} ${halfD} ${-halfW + 2} ${halfD - 5}
                          Z`}
                      fill={item.color}
                      fillOpacity="0.88"
                      stroke={isSelected ? '#2563eb' : '#0f172a'}
                      strokeWidth="1.5"
                    />
                    <rect
                      x={-halfW + 3}
                      y={-halfD + 2}
                      width={item.width - 6}
                      height="8"
                      rx="3"
                      fill="#0f172a"
                      stroke={isSelected ? '#2563eb' : '#0f172a'}
                      strokeWidth="1.2"
                    />
                  </g>
                )}

                {item.iconType === 'table_round' && (
                  <circle
                    cx="0"
                    cy="0"
                    r={Math.max(halfW - 8, 4)}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                    strokeOpacity="0.35"
                  />
                )}

                {item.iconType === 'nightstand' && (
                  <g>
                    <line
                      x1={-halfW + 6}
                      y1={0}
                      x2={halfW - 6}
                      y2={0}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      strokeOpacity="0.35"
                    />
                    <circle cx="0" cy="0" r="2.5" fill="#ffffff" fillOpacity="0.7" />
                  </g>
                )}

                {(item.shape ? item.width >= 50 && item.depth >= 30 : item.width >= 110 && item.depth >= 60) &&
                  item.iconType !== 'chair_office' &&
                  item.iconType !== 'dining_chair' &&
                  item.iconType !== 'armchair' && (
                    <text
                      x="0"
                      y="4"
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={Math.min(11, Math.max(8, item.width / 9))}
                      fontWeight="600"
                      fill="#ffffff"
                      fontFamily="system-ui, sans-serif"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {item.name}
                    </text>
                  )}
              </g>
            );
          })}

          {(state.textBoxes || []).map((item) => {
            const isSelected = selectedId === item.id || selectedIds.includes(item.id);
            const halfW = item.width / 2;
            const halfH = item.height / 2;
            const fontSize = item.fontSize || 16;
            const lines = wrapTextBoxLines(item.text, fontSize, Math.max(20, item.width - 24));
            const lineCount = lines.length;
            const lineHeight = fontSize * 1.3;
            const textBlockHeight = (lineCount - 1) * lineHeight;

            return (
              <g
                key={item.id}
                transform={`translate(${item.x}, ${item.y}) rotate(${item.rotation})`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOrSelectItem(item.id, 'textbox', e.shiftKey);
                }}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    if (e.shiftKey) {
                      toggleOrSelectItem(item.id, 'textbox', true);
                      return;
                    }
                    const worldPoint = screenToWorld(e.clientX, e.clientY);
                    startDragForIds(item.id, 'textbox', worldPoint, { x: item.x, y: item.y });
                  }
                }}
                className="cursor-move"
              >
                <rect
                  x={-halfW}
                  y={-halfH}
                  width={item.width}
                  height={item.height}
                  rx={item.borderRadius ?? 6}
                  fill={item.backgroundColor || '#ffffff'}
                  stroke={isSelected ? '#2563eb' : item.borderColor || '#cbd5e1'}
                  strokeWidth={isSelected ? '2.5' : item.borderStyle === 'none' ? '0' : '1.5'}
                  strokeDasharray={item.borderStyle === 'dashed' ? '5 3' : undefined}
                />

                <text
                  x={
                    item.textAlign === 'left'
                      ? -halfW + 12
                      : item.textAlign === 'right'
                      ? halfW - 12
                      : 0
                  }
                  y={-textBlockHeight / 2}
                  textAnchor={
                    item.textAlign === 'left'
                      ? 'start'
                      : item.textAlign === 'right'
                      ? 'end'
                      : 'middle'
                  }
                  dominantBaseline="central"
                  fontSize={fontSize}
                  fontWeight={item.bold ? '700' : '500'}
                  fontStyle={item.italic ? 'italic' : 'normal'}
                  fill={item.color || '#1e293b'}
                  fontFamily="system-ui, -apple-system, sans-serif"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {lines.map((line, idx) => (
                    <tspan
                      key={idx}
                      x={
                        item.textAlign === 'left'
                          ? -halfW + 12
                          : item.textAlign === 'right'
                          ? halfW - 12
                          : 0
                      }
                      dy={idx === 0 ? 0 : lineHeight}
                    >
                      {line || ' '}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}

          {selectedIds.length <= 1 && selectedWall && (() => {
            const midX = (selectedWall.start.x + selectedWall.end.x) / 2;
            const midY = (selectedWall.start.y + selectedWall.end.y) / 2;
            const wallLength = distance(selectedWall.start, selectedWall.end);
            const angleRad = Math.atan2(
              selectedWall.end.y - selectedWall.start.y,
              selectedWall.end.x - selectedWall.start.x
            );
            const angleDeg = (angleRad * 180) / Math.PI;

            return (
              <g key={`selected_wall_${selectedWall.id}`}>
                <g transform={`translate(${midX}, ${midY}) rotate(${angleDeg})`}>
                  <rect
                    x={-wallLength / 2 - 4}
                    y={-selectedWall.thickness / 2 - 4}
                    width={wallLength + 8}
                    height={selectedWall.thickness + 8}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth="1.8"
                    strokeDasharray="6 3"
                    rx="3"
                  />
                  <g transform={`translate(0, ${-selectedWall.thickness / 2 - 16})`}>
                    <rect
                      x="-36"
                      y="-11"
                      width="72"
                      height="22"
                      rx="4"
                      fill="#1e293b"
                      fillOpacity="0.9"
                    />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize="11"
                      fontWeight="bold"
                      fill="#ffffff"
                      fontFamily="monospace"
                    >
                      {formatDimension(wallLength, state.unit)}
                    </text>
                  </g>
                  <line
                    x1="0"
                    y1={-selectedWall.thickness / 2 - 4}
                    x2="0"
                    y2={-selectedWall.thickness / 2 - 38}
                    stroke="#2563eb"
                    strokeWidth="1.8"
                  />
                  <circle
                    cx="0"
                    cy={-selectedWall.thickness / 2 - 38}
                    r="8"
                    fill="#2563eb"
                    stroke="#ffffff"
                    strokeWidth="2"
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onStartInteraction?.();
                      setIsRotating(true);
                    }}
                  />
                </g>

                <g transform={`translate(${selectedWall.start.x}, ${selectedWall.start.y})`}>
                  <circle
                    r="8"
                    fill="#2563eb"
                    stroke="#ffffff"
                    strokeWidth="2.5"
                    className="cursor-crosshair active:scale-125 transition-transform"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onStartInteraction?.();
                      setResizeTarget({ id: selectedWall.id, type: 'wall', handle: 'start' });
                    }}
                  />
                  <circle r="3" fill="#ffffff" style={{ pointerEvents: 'none' }} />
                </g>

                <g transform={`translate(${selectedWall.end.x}, ${selectedWall.end.y})`}>
                  <circle
                    r="8"
                    fill="#2563eb"
                    stroke="#ffffff"
                    strokeWidth="2.5"
                    className="cursor-crosshair active:scale-125 transition-transform"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onStartInteraction?.();
                      setResizeTarget({ id: selectedWall.id, type: 'wall', handle: 'end' });
                    }}
                  />
                  <circle r="3" fill="#ffffff" style={{ pointerEvents: 'none' }} />
                </g>
              </g>
            );
          })()}

          {selectedIds.length <= 1 && selectedDoor && (
            <g
              transform={`translate(${selectedDoor.x}, ${selectedDoor.y}) rotate(${selectedDoor.rotation})`}
            >
              <rect
                x={-selectedDoor.width / 2 - 6}
                y="-16"
                width={selectedDoor.width + 12}
                height="32"
                fill="none"
                stroke="#2563eb"
                strokeWidth="1.8"
                strokeDasharray="6 3"
                rx="4"
              />
              <rect
                x={-selectedDoor.width / 2 - 9}
                y="-12"
                width="8"
                height="24"
                rx="2"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="1.5"
                className="cursor-ew-resize"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setResizeTarget({ id: selectedDoor.id, type: 'door', handle: 'left' });
                }}
              />
              <rect
                x={selectedDoor.width / 2 + 1}
                y="-12"
                width="8"
                height="24"
                rx="2"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="1.5"
                className="cursor-ew-resize"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setResizeTarget({ id: selectedDoor.id, type: 'door', handle: 'right' });
                }}
              />
              <text
                x="0"
                y="-26"
                textAnchor="middle"
                fontSize="11"
                fontWeight="bold"
                fill="#2563eb"
                fontFamily="monospace"
              >
                {formatDimension(selectedDoor.width, state.unit)}
              </text>
              <line x1="0" y1="-16" x2="0" y2="-44" stroke="#2563eb" strokeWidth="1.8" />
              <circle
                cx="0"
                cy="-44"
                r="8"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="2"
                className="cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setIsRotating(true);
                }}
              />
            </g>
          )}

          {selectedIds.length <= 1 && selectedWindow && (
            <g
              transform={`translate(${selectedWindow.x}, ${selectedWindow.y}) rotate(${selectedWindow.rotation})`}
            >
              <rect
                x={-selectedWindow.width / 2 - 6}
                y={-selectedWindow.thickness / 2 - 6}
                width={selectedWindow.width + 12}
                height={selectedWindow.thickness + 12}
                fill="none"
                stroke="#2563eb"
                strokeWidth="1.8"
                strokeDasharray="6 3"
                rx="4"
              />
              <rect
                x={-selectedWindow.width / 2 - 9}
                y="-12"
                width="8"
                height="24"
                rx="2"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="1.5"
                className="cursor-ew-resize"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setResizeTarget({ id: selectedWindow.id, type: 'window', handle: 'left' });
                }}
              />
              <rect
                x={selectedWindow.width / 2 + 1}
                y="-12"
                width="8"
                height="24"
                rx="2"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="1.5"
                className="cursor-ew-resize"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setResizeTarget({ id: selectedWindow.id, type: 'window', handle: 'right' });
                }}
              />
              <text
                x="0"
                y={-selectedWindow.thickness / 2 - 14}
                textAnchor="middle"
                fontSize="11"
                fontWeight="bold"
                fill="#2563eb"
                fontFamily="monospace"
              >
                {formatDimension(selectedWindow.width, state.unit)}
              </text>
              <line
                x1="0"
                y1={-selectedWindow.thickness / 2 - 6}
                x2="0"
                y2={-selectedWindow.thickness / 2 - 34}
                stroke="#2563eb"
                strokeWidth="1.8"
              />
              <circle
                cx="0"
                cy={-selectedWindow.thickness / 2 - 34}
                r="8"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="2"
                className="cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setIsRotating(true);
                }}
              />
            </g>
          )}

          {selectedIds.length <= 1 && selectedFurniture && (
            <g
              transform={`translate(${selectedFurniture.x}, ${selectedFurniture.y}) rotate(${selectedFurniture.rotation})`}
            >
              <rect
                x={-selectedFurniture.width / 2 - 6}
                y={-selectedFurniture.depth / 2 - 6}
                width={selectedFurniture.width + 12}
                height={selectedFurniture.depth + 12}
                fill="none"
                stroke="#2563eb"
                strokeWidth="1.8"
                strokeDasharray="6 3"
              />

              <rect
                x={-selectedFurniture.width / 2 - 10}
                y="-10"
                width="8"
                height="20"
                rx="2"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="1.5"
                className="cursor-ew-resize"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setResizeTarget({ id: selectedFurniture.id, type: 'furniture', handle: 'left' });
                }}
              />
              <rect
                x={selectedFurniture.width / 2 + 2}
                y="-10"
                width="8"
                height="20"
                rx="2"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="1.5"
                className="cursor-ew-resize"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setResizeTarget({ id: selectedFurniture.id, type: 'furniture', handle: 'right' });
                }}
              />
              <rect
                x="-10"
                y={selectedFurniture.depth / 2 + 2}
                width="20"
                height="8"
                rx="2"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="1.5"
                className="cursor-ns-resize"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setResizeTarget({ id: selectedFurniture.id, type: 'furniture', handle: 'bottom' });
                }}
              />

              <text
                x="0"
                y={-selectedFurniture.depth / 2 - 12}
                textAnchor="middle"
                fontSize="11"
                fontWeight="bold"
                fill="#2563eb"
                fontFamily="monospace"
              >
                {formatDimension(selectedFurniture.width, state.unit)}
              </text>
              <text
                x={selectedFurniture.width / 2 + 16}
                y="0"
                textAnchor="start"
                dominantBaseline="central"
                fontSize="11"
                fontWeight="bold"
                fill="#2563eb"
                fontFamily="monospace"
              >
                {formatDimension(selectedFurniture.depth, state.unit)}
              </text>

              <line
                x1="0"
                y1={-selectedFurniture.depth / 2 - 6}
                x2="0"
                y2={-selectedFurniture.depth / 2 - 34}
                stroke="#2563eb"
                strokeWidth="1.8"
              />
              <circle
                cx="0"
                cy={-selectedFurniture.depth / 2 - 34}
                r="8"
                fill="#2563eb"
                stroke="#ffffff"
                strokeWidth="2"
                className="cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onStartInteraction?.();
                  setIsRotating(true);
                }}
              />
            </g>
          )}

          {selectedIds.length <= 1 && selectedTextBox && (() => {
            const halfW = selectedTextBox.width / 2;
            const halfH = selectedTextBox.height / 2;
            return (
              <g
                transform={`translate(${selectedTextBox.x}, ${selectedTextBox.y}) rotate(${selectedTextBox.rotation})`}
              >
                <rect
                  x={-halfW - 4}
                  y={-halfH - 4}
                  width={selectedTextBox.width + 8}
                  height={selectedTextBox.height + 8}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth="1.8"
                  strokeDasharray="6 3"
                  rx={(selectedTextBox.borderRadius ?? 6) + 3}
                />

                <g
                  className="cursor-nwse-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setResizeTarget({ id: selectedTextBox.id, type: 'textbox', handle: 'nw' });
                  }}
                >
                  <circle cx={-halfW} cy={-halfH} r="12" fill="transparent" />
                  <rect
                    x={-halfW - 5}
                    y={-halfH - 5}
                    width="10"
                    height="10"
                    rx="2"
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2"
                  />
                </g>

                <g
                  className="cursor-nesw-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setResizeTarget({ id: selectedTextBox.id, type: 'textbox', handle: 'ne' });
                  }}
                >
                  <circle cx={halfW} cy={-halfH} r="12" fill="transparent" />
                  <rect
                    x={halfW - 5}
                    y={-halfH - 5}
                    width="10"
                    height="10"
                    rx="2"
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2"
                  />
                </g>

                <g
                  className="cursor-nwse-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setResizeTarget({ id: selectedTextBox.id, type: 'textbox', handle: 'se' });
                  }}
                >
                  <circle cx={halfW} cy={halfH} r="12" fill="transparent" />
                  <rect
                    x={halfW - 5}
                    y={halfH - 5}
                    width="10"
                    height="10"
                    rx="2"
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2"
                  />
                </g>

                <g
                  className="cursor-nesw-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setResizeTarget({ id: selectedTextBox.id, type: 'textbox', handle: 'sw' });
                  }}
                >
                  <circle cx={-halfW} cy={halfH} r="12" fill="transparent" />
                  <rect
                    x={-halfW - 5}
                    y={halfH - 5}
                    width="10"
                    height="10"
                    rx="2"
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2"
                  />
                </g>

                <g
                  className="cursor-ew-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setResizeTarget({ id: selectedTextBox.id, type: 'textbox', handle: 'left' });
                  }}
                >
                  <rect x={-halfW - 10} y="-12" width="18" height="24" fill="transparent" />
                  <rect
                    x={-halfW - 4}
                    y="-9"
                    width="8"
                    height="18"
                    rx="3"
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2"
                  />
                </g>

                <g
                  className="cursor-ew-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setResizeTarget({ id: selectedTextBox.id, type: 'textbox', handle: 'right' });
                  }}
                >
                  <rect x={halfW - 8} y="-12" width="18" height="24" fill="transparent" />
                  <rect
                    x={halfW - 4}
                    y="-9"
                    width="8"
                    height="18"
                    rx="3"
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2"
                  />
                </g>

                <g
                  className="cursor-ns-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setResizeTarget({ id: selectedTextBox.id, type: 'textbox', handle: 'top' });
                  }}
                >
                  <rect x="-12" y={-halfH - 10} width="24" height="18" fill="transparent" />
                  <rect
                    x="-9"
                    y={-halfH - 4}
                    width="18"
                    height="8"
                    rx="3"
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2"
                  />
                </g>

                <g
                  className="cursor-ns-resize"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setResizeTarget({ id: selectedTextBox.id, type: 'textbox', handle: 'bottom' });
                  }}
                >
                  <rect x="-12" y={halfH - 8} width="24" height="18" fill="transparent" />
                  <rect
                    x="-9"
                    y={halfH - 4}
                    width="18"
                    height="8"
                    rx="3"
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2"
                  />
                </g>

                <text
                  x="0"
                  y={-halfH - 12}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="bold"
                  fill="#2563eb"
                  fontFamily="monospace"
                >
                  {formatDimension(selectedTextBox.width, state.unit)} × {formatDimension(selectedTextBox.height, state.unit)}
                </text>

                <line
                  x1="0"
                  y1={-halfH - 5}
                  x2="0"
                  y2={-halfH - 32}
                  stroke="#2563eb"
                  strokeWidth="1.8"
                />
                <circle
                  cx="0"
                  cy={-halfH - 32}
                  r="7"
                  fill="#2563eb"
                  stroke="#ffffff"
                  strokeWidth="2"
                  className="cursor-grab active:cursor-grabbing"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onStartInteraction?.();
                    setIsRotating(true);
                  }}
                />
              </g>
            );
          })()}

          {state.measurements.map((m) => {
            const isSelected = selectedId === m.id || selectedIds.includes(m.id);
            const dist = distance(m.start, m.end);
            const midX = (m.start.x + m.end.x) / 2;
            const midY = (m.start.y + m.end.y) / 2;

            return (
              <g
                key={m.id}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOrSelectItem(m.id, 'measurement', e.shiftKey);
                }}
                className="cursor-pointer"
              >
                <line
                  x1={m.start.x}
                  y1={m.start.y}
                  x2={m.end.x}
                  y2={m.end.y}
                  stroke="transparent"
                  strokeWidth="20"
                />
                <line
                  x1={m.start.x}
                  y1={m.start.y}
                  x2={m.end.x}
                  y2={m.end.y}
                  stroke={isSelected ? '#2563eb' : '#e11d48'}
                  strokeWidth={isSelected ? '3' : '2'}
                  strokeDasharray="6 3"
                />
                <circle
                  cx={m.start.x}
                  cy={m.start.y}
                  r={isSelected ? '6' : '4.5'}
                  fill={isSelected ? '#2563eb' : '#e11d48'}
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
                <circle
                  cx={m.end.x}
                  cy={m.end.y}
                  r={isSelected ? '6' : '4.5'}
                  fill={isSelected ? '#2563eb' : '#e11d48'}
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
                <g transform={`translate(${midX}, ${midY})`}>
                  <rect
                    x="-34"
                    y="-12"
                    width="68"
                    height="24"
                    rx="6"
                    fill={isSelected ? '#2563eb' : '#e11d48'}
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="11"
                    fontWeight="bold"
                    fill="#ffffff"
                    fontFamily="monospace"
                  >
                    {formatDimension(dist, state.unit)}
                  </text>
                </g>
              </g>
            );
          })}

          {measureStart && measureEnd && (
            <g>
              <line
                x1={measureStart.x}
                y1={measureStart.y}
                x2={measureEnd.x}
                y2={measureEnd.y}
                stroke="#e11d48"
                strokeWidth="2"
                strokeDasharray="5 3"
              />
              <circle cx={measureStart.x} cy={measureStart.y} r="4" fill="#e11d48" />
              <circle cx={measureEnd.x} cy={measureEnd.y} r="4" fill="#e11d48" />
              <g
                transform={`translate(${(measureStart.x + measureEnd.x) / 2}, ${
                  (measureStart.y + measureEnd.y) / 2
                })`}
              >
                <rect
                  x="-36"
                  y="-12"
                  width="72"
                  height="24"
                  rx="4"
                  fill="#e11d48"
                  fillOpacity="0.95"
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="12"
                  fontWeight="bold"
                  fill="#ffffff"
                  fontFamily="monospace"
                >
                  {formatDimension(distance(measureStart, measureEnd), state.unit)}
                </text>
              </g>
            </g>
          )}

          {calibStart && calibEnd && (
            <g>
              <line
                x1={calibStart.x}
                y1={calibStart.y}
                x2={calibEnd.x}
                y2={calibEnd.y}
                stroke="#7c3aed"
                strokeWidth="3"
                strokeDasharray="6 3"
              />
              <circle cx={calibStart.x} cy={calibStart.y} r="5" fill="#7c3aed" />
              <circle cx={calibEnd.x} cy={calibEnd.y} r="5" fill="#7c3aed" />
              <g
                transform={`translate(${(calibStart.x + calibEnd.x) / 2}, ${
                  (calibStart.y + calibEnd.y) / 2
                })`}
              >
                <rect
                  x="-48"
                  y="-13"
                  width="96"
                  height="26"
                  rx="5"
                  fill="#7c3aed"
                  fillOpacity="0.95"
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="11"
                  fontWeight="bold"
                  fill="#ffffff"
                  fontFamily="monospace"
                >
                  Calibrate: {formatDimension(distance(calibStart, calibEnd), state.unit)}
                </text>
              </g>
            </g>
          )}

          {selectionBox && (
            <g className="selection-marquee" style={{ pointerEvents: 'none' }}>
              <rect
                x={Math.min(selectionBox.start.x, selectionBox.current.x)}
                y={Math.min(selectionBox.start.y, selectionBox.current.y)}
                width={Math.abs(selectionBox.current.x - selectionBox.start.x)}
                height={Math.abs(selectionBox.current.y - selectionBox.start.y)}
                fill="rgba(37, 99, 235, 0.12)"
                stroke="#2563eb"
                strokeWidth="1.5"
                strokeDasharray="5 3"
              />
            </g>
          )}
        </g>
      </svg>

      {tool === 'calibrate' && !pendingCalibDistCm && (
        <div className="canvas-floating-banner">
          <span>
            <strong>Scale Calibration:</strong> Click the start and end of any known wall or dimension line (hold <kbd>Shift</kbd> for 90° snap).
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setCalibStart(null);
              setCalibEnd(null);
              setTool('select');
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {pendingCalibDistCm !== null && (
        <div className="calib-popover-backdrop">
          <form className="calib-popover-card" onSubmit={handleApplyCalibration}>
            <h4 className="calib-popover-title">Calibrate Floorplan Scale</h4>
            <p className="calib-popover-desc">
              Enter the real-world length of the reference line you just traced (currently{' '}
              <code>{formatDimension(pendingCalibDistCm, state.unit)}</code>):
            </p>
            <div className="flex gap-2 items-center mt-2">
              <input
                type="number"
                step="0.05"
                min="0.2"
                autoFocus
                value={calibInputValue}
                onChange={(e) => setCalibInputValue(e.target.value)}
                className="field-input flex-1"
              />
              <span className="text-xs font-semibold text-slate-600">
                {state.unit === 'm' ? 'meters (m)' : 'feet (ft)'}
              </span>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setPendingCalibDistCm(null);
                  setTool('select');
                }}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary">
                Rescale Floorplan
              </button>
            </div>
          </form>
        </div>
      )}
      <div className="canvas-grid-hud">
        <div className="grid-hud-icon">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect x="1" y="1" width="9" height="9" stroke="#64748b" strokeWidth="1" strokeDasharray="2 2" fill="rgba(148, 163, 184, 0.2)" />
            <rect x="12" y="1" width="9" height="9" stroke="#64748b" strokeWidth="1" strokeDasharray="2 2" />
            <rect x="1" y="12" width="9" height="9" stroke="#64748b" strokeWidth="1" strokeDasharray="2 2" />
            <rect x="12" y="12" width="9" height="9" stroke="#64748b" strokeWidth="1" strokeDasharray="2 2" />
          </svg>
        </div>
        <div className="grid-hud-details">
          <span className="grid-hud-title">
            1 Grid Cell = <strong>{formatDimension(state.gridSize, state.unit)} × {formatDimension(state.gridSize, state.unit)}</strong>
          </span>
          <span className="grid-hud-sub">
            Snap: <span className={state.gridSnap ? 'text-emerald-600 font-semibold' : 'text-slate-400'}>{state.gridSnap ? 'Active' : 'Off'}</span> (Zoom {Math.round(zoom * 100)}%)
          </span>
        </div>
      </div>
    </div>
  );
};


