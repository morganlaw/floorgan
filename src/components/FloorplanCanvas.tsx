import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  FloorplanState,
  ToolMode,
  Point,
  Wall,
  Door,
  WindowItem,
  Measurement,
} from '../types';
import {
  snapPointToGrid,
  distance,
  snapAngle,
  formatDimension,
} from '../utils/geometry';
import { rescaleFloorplanState } from '../utils/floorplanParser';

interface Props {
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  tool: ToolMode;
  setTool: (tool: ToolMode) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedType: 'furniture' | 'wall' | 'door' | 'window' | 'measurement' | null;
  setSelectedType: (type: 'furniture' | 'wall' | 'door' | 'window' | 'measurement' | null) => void;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  pan: Point;
  setPan: React.Dispatch<React.SetStateAction<Point>>;
}

export const FloorplanCanvas: React.FC<Props> = ({
  state,
  setState,
  tool,
  setTool,
  selectedId,
  setSelectedId,
  selectedType,
  setSelectedType,
  zoom,
  setZoom,
  pan,
  setPan,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Interaction states
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<Point>({ x: 0, y: 0 });

  // Wall creation
  const [wallStart, setWallStart] = useState<Point | null>(null);
  const [wallCurrent, setWallCurrent] = useState<Point | null>(null);

  // Dragging placed item
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<Point>({ x: 0, y: 0 });

  // Rotating placed item
  const [isRotating, setIsRotating] = useState(false);

  // Measure tool
  const [measureStart, setMeasureStart] = useState<Point | null>(null);
  const [measureEnd, setMeasureEnd] = useState<Point | null>(null);

  // Scale calibration tool
  const [calibStart, setCalibStart] = useState<Point | null>(null);
  const [calibEnd, setCalibEnd] = useState<Point | null>(null);
  const [pendingCalibDistCm, setPendingCalibDistCm] = useState<number | null>(null);
  const [calibInputValue, setCalibInputValue] = useState<string>('4.0');

  // Coordinate conversion: Screen pixels -> SVG canvas world coordinates (cm)
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

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(Math.max(zoom * zoomFactor, 0.2), 4.0);

    // Zoom towards cursor
    if (svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      setPan((prevPan) => ({
        x: cursorX - ((cursorX - prevPan.x) / zoom) * newZoom,
        y: cursorY - ((cursorY - prevPan.y) / zoom) * newZoom,
      }));
    }
    setZoom(newZoom);
  };

  // Pointer down on canvas
  const handlePointerDown = (e: React.PointerEvent) => {
    // Middle click or Space/Pan tool triggers pan
    if (e.button === 1 || tool === 'pan' || e.shiftKey && e.button === 0 && tool === 'select') {
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
        // Place wall
        const finalEnd = e.shiftKey ? snapAngle(wallStart, snappedPoint) : snappedPoint;
        if (distance(wallStart, finalEnd) > 10) {
          const newWall: Wall = {
            id: 'wall_' + Date.now(),
            start: wallStart,
            end: finalEnd,
            thickness: 15,
          };
          setState((prev) => ({ ...prev, walls: [...prev.walls, newWall] }));
          // Complete single wall segment and revert to select tool
          setWallStart(null);
          setWallCurrent(null);
          setTool('select');
          setSelectedId(newWall.id);
          setSelectedType('wall');
        }
      }
    } else if (tool === 'door') {
      const newDoor: Door = {
        id: 'door_' + Date.now(),
        x: snappedPoint.x,
        y: snappedPoint.y,
        width: 80,
        rotation: 0,
        swingDirection: 'left',
      };
      setState((prev) => ({ ...prev, doors: [...prev.doors, newDoor] }));
      setSelectedId(newDoor.id);
      setSelectedType('door');
      setTool('select');
    } else if (tool === 'window') {
      const newWin: WindowItem = {
        id: 'win_' + Date.now(),
        x: snappedPoint.x,
        y: snappedPoint.y,
        width: 120,
        thickness: 15,
        rotation: 0,
      };
      setState((prev) => ({ ...prev, windows: [...prev.windows, newWin] }));
      setSelectedId(newWin.id);
      setSelectedType('window');
      setTool('select');
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
      // Clicked on empty canvas background -> deselect
      setSelectedId(null);
      setSelectedType(null);
    }
  };

  // Pointer move
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
      setWallCurrent(e.shiftKey ? snapAngle(wallStart, snappedPoint) : snappedPoint);
    }

    if (tool === 'measure' && measureStart) {
      setMeasureEnd(snappedPoint);
    }

    if (tool === 'calibrate' && calibStart) {
      setCalibEnd(e.shiftKey ? snapAngle(calibStart, snappedPoint) : snappedPoint);
    }

    if (isDragging && selectedId) {
      const targetX = snapPointToGrid(
        { x: worldPoint.x - dragOffset.x, y: worldPoint.y - dragOffset.y },
        state.gridSize,
        state.gridSnap
      );

      if (selectedType === 'furniture') {
        setState((prev) => ({
          ...prev,
          furniture: prev.furniture.map((item) =>
            item.id === selectedId ? { ...item, x: targetX.x, y: targetX.y } : item
          ),
        }));
      } else if (selectedType === 'door') {
        setState((prev) => ({
          ...prev,
          doors: prev.doors.map((item) =>
            item.id === selectedId ? { ...item, x: targetX.x, y: targetX.y } : item
          ),
        }));
      } else if (selectedType === 'window') {
        setState((prev) => ({
          ...prev,
          windows: prev.windows.map((item) =>
            item.id === selectedId ? { ...item, x: targetX.x, y: targetX.y } : item
          ),
        }));
      }
    }

    if (isRotating && selectedId && selectedType === 'furniture') {
      const item = state.furniture.find((f) => f.id === selectedId);
      if (item) {
        const dx = worldPoint.x - item.x;
        const dy = worldPoint.y - item.y;
        let angleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90);
        if (angleDeg < 0) angleDeg += 360;

        // Snap to 45 deg if shift is held
        if (e.shiftKey) {
          angleDeg = Math.round(angleDeg / 45) * 45;
        }

        setState((prev) => ({
          ...prev,
          furniture: prev.furniture.map((f) =>
            f.id === selectedId ? { ...f, rotation: angleDeg % 360 } : f
          ),
        }));
      }
    }
  };

  // Pointer up
  const handlePointerUp = () => {
    setIsPanning(false);
    setIsDragging(false);
    setIsRotating(false);
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

  // Keyboard shortcuts (Escape, Backspace, Delete)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setWallStart(null);
        setWallCurrent(null);
        setMeasureStart(null);
        setMeasureEnd(null);
        setCalibStart(null);
        setCalibEnd(null);
        setPendingCalibDistCm(null);
        setTool('select');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        // Delete selected element
        if (selectedType === 'furniture') {
          setState((prev) => ({
            ...prev,
            furniture: prev.furniture.filter((f) => f.id !== selectedId),
          }));
        } else if (selectedType === 'wall') {
          setState((prev) => ({
            ...prev,
            walls: prev.walls.filter((w) => w.id !== selectedId),
          }));
        } else if (selectedType === 'door') {
          setState((prev) => ({
            ...prev,
            doors: prev.doors.filter((d) => d.id !== selectedId),
          }));
        } else if (selectedType === 'window') {
          setState((prev) => ({
            ...prev,
            windows: prev.windows.filter((w) => w.id !== selectedId),
          }));
        } else if (selectedType === 'measurement') {
          setState((prev) => ({
            ...prev,
            measurements: prev.measurements.filter((m) => m.id !== selectedId),
          }));
        }
        setSelectedId(null);
        setSelectedType(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, selectedType, setState, setSelectedId, setSelectedType, setTool]);

  // Selected furniture helper
  const selectedFurniture = state.furniture.find((f) => f.id === selectedId);

  return (
    <div className="canvas-wrapper">
      <svg
        ref={svgRef}
        id="floorplan-svg"
        className="floorplan-svg"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <defs>
          {/* Minor Grid Pattern (10cm or 20cm) */}
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
          {/* Major Grid Pattern (100cm = 1m) */}
          <pattern id="majorGrid" width="100" height="100" patternUnits="userSpaceOnUse">
            <rect width="100" height="100" fill="url(#minorGrid)" />
            <path d="M 100 0 L 0 0 0 100" fill="none" stroke="#cbd5e1" strokeWidth="1.5" />
          </pattern>
        </defs>

        {/* Scaled & Panned Group */}
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Background Grid */}
          <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#majorGrid)" />

          {/* Imported Reference Floorplan Underlay */}
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

          {/* Coordinate Origin Crosshair */}
          <line x1="-30" y1="0" x2="30" y2="0" stroke="#94a3b8" strokeWidth="1.5" />
          <line x1="0" y1="-30" x2="0" y2="30" stroke="#94a3b8" strokeWidth="1.5" />
          <text x="8" y="-8" fontSize="11" fill="#94a3b8" fontFamily="sans-serif">
            (0, 0)
          </text>

          {/* Placed Walls */}
          {state.walls.map((wall) => {
            const isSelected = selectedId === wall.id;
            const wallLength = distance(wall.start, wall.end);
            const midX = (wall.start.x + wall.end.x) / 2;
            const midY = (wall.start.y + wall.end.y) / 2;

            return (
              <g
                key={wall.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(wall.id);
                  setSelectedType('wall');
                }}
                className="cursor-pointer"
              >
                {/* Wall body */}
                <line
                  x1={wall.start.x}
                  y1={wall.start.y}
                  x2={wall.end.x}
                  y2={wall.end.y}
                  stroke={isSelected ? '#3b82f6' : '#1e293b'}
                  strokeWidth={wall.thickness}
                  strokeLinecap="square"
                />
                {/* Wall centerline accent */}
                <line
                  x1={wall.start.x}
                  y1={wall.start.y}
                  x2={wall.end.x}
                  y2={wall.end.y}
                  stroke={isSelected ? '#93c5fd' : '#475569'}
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                {/* Dimension label */}
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

          {/* Wall drawing preview line */}
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
              {/* Length preview tooltip */}
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

          {/* Doors */}
          {state.doors.map((door) => {
            const isSelected = selectedId === door.id;
            return (
              <g
                key={door.id}
                transform={`translate(${door.x}, ${door.y}) rotate(${door.rotation})`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(door.id);
                  setSelectedType('door');
                }}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    setSelectedId(door.id);
                    setSelectedType('door');
                    setIsDragging(true);
                    const worldPoint = screenToWorld(e.clientX, e.clientY);
                    setDragOffset({ x: worldPoint.x - door.x, y: worldPoint.y - door.y });
                  }
                }}
                className="cursor-move"
              >
                {/* Wall Opening Cutout */}
                <rect
                  x={-door.width / 2}
                  y="-12"
                  width={door.width}
                  height="24"
                  fill="#ffffff"
                  stroke={isSelected ? '#3b82f6' : '#cbd5e1'}
                  strokeWidth="2"
                />
                {/* Swing arc (quarter circle) */}
                <path
                  d={`M ${-door.width / 2} 0 A ${door.width} ${door.width} 0 0 1 ${
                    -door.width / 2 + door.width
                  } ${door.width}`}
                  fill="none"
                  stroke="#94a3b8"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                />
                {/* Door leaf line */}
                <line
                  x1={-door.width / 2}
                  y1="0"
                  x2={-door.width / 2}
                  y2={door.width}
                  stroke="#78350f"
                  strokeWidth="4"
                />
              </g>
            );
          })}

          {/* Windows */}
          {state.windows.map((win) => {
            const isSelected = selectedId === win.id;
            return (
              <g
                key={win.id}
                transform={`translate(${win.x}, ${win.y}) rotate(${win.rotation})`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(win.id);
                  setSelectedType('window');
                }}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    setSelectedId(win.id);
                    setSelectedType('window');
                    setIsDragging(true);
                    const worldPoint = screenToWorld(e.clientX, e.clientY);
                    setDragOffset({ x: worldPoint.x - win.x, y: worldPoint.y - win.y });
                  }
                }}
                className="cursor-move"
              >
                {/* Wall opening */}
                <rect
                  x={-win.width / 2}
                  y={-win.thickness / 2}
                  width={win.width}
                  height={win.thickness}
                  fill="#ffffff"
                  stroke={isSelected ? '#3b82f6' : '#64748b'}
                  strokeWidth="1.5"
                />
                {/* Double glass panes */}
                <line
                  x1={-win.width / 2}
                  y1={-win.thickness / 4}
                  x2={win.width / 2}
                  y2={-win.thickness / 4}
                  stroke="#38bdf8"
                  strokeWidth="2"
                />
                <line
                  x1={-win.width / 2}
                  y1={win.thickness / 4}
                  x2={win.width / 2}
                  y2={win.thickness / 4}
                  stroke="#38bdf8"
                  strokeWidth="2"
                />
              </g>
            );
          })}

          {/* Furniture items */}
          {state.furniture.map((item) => {
            const isSelected = selectedId === item.id;
            const halfW = item.width / 2;
            const halfD = item.depth / 2;

            return (
              <g
                key={item.id}
                transform={`translate(${item.x}, ${item.y}) rotate(${item.rotation})`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(item.id);
                  setSelectedType('furniture');
                }}
                onPointerDown={(e) => {
                  if (tool === 'select') {
                    e.stopPropagation();
                    setSelectedId(item.id);
                    setSelectedType('furniture');
                    setIsDragging(true);
                    const worldPoint = screenToWorld(e.clientX, e.clientY);
                    setDragOffset({ x: worldPoint.x - item.x, y: worldPoint.y - item.y });
                  }
                }}
                className="cursor-move"
              >
                {/* Main furniture body: render for non-chair items or items with full bounding body */}
                {item.iconType !== 'chair_office' && item.iconType !== 'dining_chair' && (
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

                {/* Architectural Internal Detailing */}
                {/* Sofa */}
                {(item.iconType === 'sofa' || item.iconType === 'sofa_2') && (
                  <g>
                    {/* Backrest */}
                    <rect
                      x={-halfW + 6}
                      y={-halfD + 4}
                      width={item.width - 12}
                      height={item.depth * 0.28}
                      rx="4"
                      fill="#0f172a"
                      fillOpacity="0.18"
                    />
                    {/* Armrests */}
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

                {/* Bed */}
                {(item.iconType === 'bed_double' || item.iconType === 'bed_single') && (
                  <g>
                    {/* Headboard */}
                    <rect
                      x={-halfW + 4}
                      y={-halfD + 2}
                      width={item.width - 8}
                      height="18"
                      rx="2"
                      fill="#1e1b4b"
                      fillOpacity="0.3"
                    />
                    {/* Pillows */}
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
                    {/* Duvet Line */}
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

                {/* Dining Set */}
                {item.iconType === 'dining_set' && (
                  <g>
                    {/* Table Surface */}
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

                {/* Desk */}
                {item.iconType === 'desk' && (
                  <g>
                    {/* Monitor */}
                    <rect
                      x="-25"
                      y={-halfD + 8}
                      width="50"
                      height="10"
                      rx="2"
                      fill="#0f172a"
                    />
                    {/* Keyboard */}
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

                {/* Armchair */}
                {item.iconType === 'armchair' && (
                  <g>
                    {/* Backrest Cushion */}
                    <rect
                      x={-halfW + 12}
                      y={-halfD + 5}
                      width={item.width - 24}
                      height={20}
                      rx="5"
                      fill="#0f172a"
                      fillOpacity="0.22"
                    />
                    {/* Wide Armrests */}
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
                    {/* Seat Cushion */}
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

                {/* Office Chair */}
                {item.iconType === 'chair_office' && (
                  <g>
                    {/* Hit box area for clicking and dragging */}
                    <rect
                      x={-halfW}
                      y={-halfD}
                      width={item.width}
                      height={item.depth}
                      fill="transparent"
                    />
                    {/* 5-Star Caster Base Spokes */}
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
                    {/* Center Swivel Hub */}
                    <circle cx="0" cy="2" r="4.5" fill="#1e293b" />
                    {/* Seat Cushion */}
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
                    {/* Backrest Spine connector */}
                    <line x1="0" y1="-16" x2="0" y2="-12" stroke="#0f172a" strokeWidth="3" />
                    {/* Curved Backrest */}
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
                    {/* Armrest Pads */}
                    <rect x="-26" y="-8" width="5" height="18" rx="2" fill="#1e293b" />
                    <rect x="21" y="-8" width="5" height="18" rx="2" fill="#1e293b" />
                  </g>
                )}

                {/* Dining Chair */}
                {item.iconType === 'dining_chair' && (
                  <g>
                    {/* Hit box */}
                    <rect
                      x={-halfW}
                      y={-halfD}
                      width={item.width}
                      height={item.depth}
                      fill="transparent"
                    />
                    {/* Contoured Seat */}
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
                    {/* Backrest Rail */}
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

                {/* Round Table Detail */}
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

                {/* Nightstand Detail */}
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

                {/* Label: only render on larger items without detailed central graphics */}
                {item.width >= 110 &&
                  item.depth >= 60 &&
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

          {/* Selection Box & Rotation Handle for Selected Furniture */}
          {selectedFurniture && (
            <g
              transform={`translate(${selectedFurniture.x}, ${selectedFurniture.y}) rotate(${selectedFurniture.rotation})`}
            >
              {/* Highlight Bounding Box */}
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

              {/* Dimension indicators on edges */}
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
                x={selectedFurniture.width / 2 + 12}
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

              {/* Rotation Handle */}
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
                  setIsRotating(true);
                }}
              />
            </g>
          )}

          {/* Placed Persistent Measurements */}
          {state.measurements.map((m) => {
            const isSelected = selectedId === m.id;
            const dist = distance(m.start, m.end);
            const midX = (m.start.x + m.end.x) / 2;
            const midY = (m.start.y + m.end.y) / 2;

            return (
              <g
                key={m.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(m.id);
                  setSelectedType('measurement');
                }}
                className="cursor-pointer"
              >
                {/* Invisible wide hit area for easy clicking */}
                <line
                  x1={m.start.x}
                  y1={m.start.y}
                  x2={m.end.x}
                  y2={m.end.y}
                  stroke="transparent"
                  strokeWidth="20"
                />
                {/* Visible measurement line */}
                <line
                  x1={m.start.x}
                  y1={m.start.y}
                  x2={m.end.x}
                  y2={m.end.y}
                  stroke={isSelected ? '#2563eb' : '#e11d48'}
                  strokeWidth={isSelected ? '3' : '2'}
                  strokeDasharray="6 3"
                />
                {/* End ticks / dots */}
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
                {/* Dimension Badge */}
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

          {/* Measuring Tape Tool Preview */}
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

          {/* Scale Calibration Tool Preview */}
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
        </g>
      </svg>

      {/* Active Scale Calibration Instruction Banner */}
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

      {/* Scale Calibration Input Dialog */}
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
    </div>
  );
};

