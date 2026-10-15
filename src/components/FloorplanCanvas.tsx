import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  FloorplanState,
  ToolMode,
  Point,
  Wall,
  Door,
  WindowItem,
} from '../types';
import {
  snapPointToGrid,
  distance,
  snapAngle,
  formatDimension,
} from '../utils/geometry';

interface Props {
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  tool: ToolMode;
  setTool: (tool: ToolMode) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedType: 'furniture' | 'wall' | 'door' | 'window' | null;
  setSelectedType: (type: 'furniture' | 'wall' | 'door' | 'window' | null) => void;
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
      setMeasureStart(snappedPoint);
      setMeasureEnd(snappedPoint);
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

    if (tool === 'measure') {
      // Keep measure visible until next click
    }
  };

  // Keyboard shortcuts (Escape, Backspace, Delete)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setWallStart(null);
        setWallCurrent(null);
        setMeasureStart(null);
        setMeasureEnd(null);
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
        }
        setSelectedId(null);
        setSelectedType(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, selectedType, setState, setSelectedId, setSelectedType]);

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
                {/* Main furniture body */}
                <rect
                  x={-halfW}
                  y={-halfD}
                  width={item.width}
                  height={item.depth}
                  rx="6"
                  fill={item.color}
                  fillOpacity="0.88"
                  stroke={isSelected ? '#2563eb' : '#0f172a'}
                  strokeWidth={isSelected ? '3' : '1.5'}
                />

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

                {/* Label */}
                <text
                  x="0"
                  y="4"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="11"
                  fontWeight="600"
                  fill="#ffffff"
                  fontFamily="system-ui, sans-serif"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {item.name}
                </text>
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
        </g>
      </svg>
    </div>
  );
};
