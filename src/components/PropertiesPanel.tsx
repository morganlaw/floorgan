import React from 'react';
import {
  RotateCw,
  Copy,
  Trash2,
  ArrowUp,
  ArrowDown,
  Info,
} from 'lucide-react';
import { FloorplanState, PlacedFurniture } from '../types';
import { formatDimension, distance } from '../utils/geometry';

interface Props {
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedType: 'furniture' | 'wall' | 'door' | 'window' | null;
  setSelectedType: (type: any) => void;
}

export const PropertiesPanel: React.FC<Props> = ({
  state,
  setState,
  selectedId,
  setSelectedId,
  selectedType,
  setSelectedType,
}) => {
  const selectedFurniture = state.furniture.find((f) => f.id === selectedId);
  const selectedWall = state.walls.find((w) => w.id === selectedId);
  const selectedDoor = state.doors.find((d) => d.id === selectedId);
  const selectedWindow = state.windows.find((w) => w.id === selectedId);

  const colors = [
    '#334155', // Slate
    '#475569', // Steel
    '#6366f1', // Indigo
    '#0284c7', // Sky
    '#0f766e', // Teal
    '#15803d', // Green
    '#b45309', // Amber / Wood
    '#78350f', // Dark Wood
    '#dc2626', // Crimson
  ];

  // Furniture handlers
  const updateFurniture = (updates: Partial<PlacedFurniture>) => {
    if (!selectedId) return;
    setState((prev) => ({
      ...prev,
      furniture: prev.furniture.map((f) => (f.id === selectedId ? { ...f, ...updates } : f)),
    }));
  };

  const handleRotate = (deltaDegrees: number) => {
    if (selectedFurniture) {
      const nextRotation = (selectedFurniture.rotation + deltaDegrees + 360) % 360;
      updateFurniture({ rotation: nextRotation });
    } else if (selectedDoor) {
      setState((prev) => ({
        ...prev,
        doors: prev.doors.map((d) =>
          d.id === selectedId ? { ...d, rotation: (d.rotation + deltaDegrees + 360) % 360 } : d
        ),
      }));
    } else if (selectedWindow) {
      setState((prev) => ({
        ...prev,
        windows: prev.windows.map((w) =>
          w.id === selectedId ? { ...w, rotation: (w.rotation + deltaDegrees + 360) % 360 } : w
        ),
      }));
    }
  };

  const handleDuplicate = () => {
    if (selectedFurniture) {
      const copy: PlacedFurniture = {
        ...selectedFurniture,
        id: 'furn_' + Date.now(),
        x: selectedFurniture.x + 20,
        y: selectedFurniture.y + 20,
      };
      setState((prev) => ({ ...prev, furniture: [...prev.furniture, copy] }));
      setSelectedId(copy.id);
    }
  };

  const handleDelete = () => {
    if (!selectedId) return;
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
  };

  const handleReorder = (direction: 'front' | 'back') => {
    if (!selectedFurniture) return;
    setState((prev) => {
      const list = [...prev.furniture];
      const index = list.findIndex((f) => f.id === selectedFurniture.id);
      if (index === -1) return prev;
      const [item] = list.splice(index, 1);
      if (direction === 'front') {
        list.push(item);
      } else {
        list.unshift(item);
      }
      return { ...prev, furniture: list };
    });
  };

  return (
    <aside className="properties-panel">
      <div className="panel-header">
        <h3 className="panel-title">Inspector</h3>
      </div>

      {/* Selected Furniture Inspector */}
      {selectedFurniture && (
        <div className="inspector-content">
          <div className="field-group">
            <label className="field-label">Name</label>
            <input
              type="text"
              value={selectedFurniture.name}
              onChange={(e) => updateFurniture({ name: e.target.value })}
              className="field-input"
            />
          </div>

          {/* Dimensions */}
          <div className="field-row">
            <div className="field-group flex-1">
              <label className="field-label">Width ({state.unit})</label>
              <input
                type="number"
                min="20"
                step="5"
                value={
                  state.unit === 'm'
                    ? (selectedFurniture.width / 100).toFixed(2)
                    : (selectedFurniture.width / 2.54 / 12).toFixed(1)
                }
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val > 0) {
                    const cm = state.unit === 'm' ? val * 100 : val * 12 * 2.54;
                    updateFurniture({ width: Math.round(cm) });
                  }
                }}
                className="field-input"
              />
            </div>
            <div className="field-group flex-1">
              <label className="field-label">Depth ({state.unit})</label>
              <input
                type="number"
                min="20"
                step="5"
                value={
                  state.unit === 'm'
                    ? (selectedFurniture.depth / 100).toFixed(2)
                    : (selectedFurniture.depth / 2.54 / 12).toFixed(1)
                }
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val > 0) {
                    const cm = state.unit === 'm' ? val * 100 : val * 12 * 2.54;
                    updateFurniture({ depth: Math.round(cm) });
                  }
                }}
                className="field-input"
              />
            </div>
          </div>

          {/* Rotation Control */}
          <div className="field-group">
            <div className="flex justify-between items-center mb-1">
              <label className="field-label">Rotation</label>
              <span className="text-xs font-mono font-bold text-blue-600">
                {selectedFurniture.rotation}°
              </span>
            </div>
            <div className="flex gap-2 items-center">
              <input
                type="range"
                min="0"
                max="359"
                value={selectedFurniture.rotation}
                onChange={(e) => updateFurniture({ rotation: parseInt(e.target.value) })}
                className="slider-range flex-1"
              />
              <button
                className="tool-btn-icon"
                onClick={() => handleRotate(90)}
                title="Rotate 90 degrees clockwise"
              >
                <RotateCw size={15} />
              </button>
            </div>
          </div>

          {/* Color Palette */}
          <div className="field-group">
            <label className="field-label">Finish / Color</label>
            <div className="color-palette">
              {colors.map((c) => (
                <button
                  key={c}
                  className={`color-swatch ${selectedFurniture.color === c ? 'selected' : ''}`}
                  style={{ backgroundColor: c }}
                  onClick={() => updateFurniture({ color: c })}
                />
              ))}
            </div>
          </div>

          {/* Layer Ordering */}
          <div className="field-group">
            <label className="field-label">Z-Order</label>
            <div className="flex gap-2">
              <button
                className="btn-secondary flex-1"
                onClick={() => handleReorder('front')}
                title="Bring to front"
              >
                <ArrowUp size={14} />
                <span>Bring Front</span>
              </button>
              <button
                className="btn-secondary flex-1"
                onClick={() => handleReorder('back')}
                title="Send to back"
              >
                <ArrowDown size={14} />
                <span>Send Back</span>
              </button>
            </div>
          </div>

          <div className="divider" />

          {/* Action buttons */}
          <div className="flex gap-2">
            <button className="btn-secondary flex-1" onClick={handleDuplicate}>
              <Copy size={15} />
              <span>Duplicate</span>
            </button>
            <button className="btn-danger flex-1" onClick={handleDelete}>
              <Trash2 size={15} />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}

      {/* Selected Wall Inspector */}
      {selectedWall && (
        <div className="inspector-content">
          <div className="info-card">
            <span className="info-title">Wall Segment</span>
            <span className="info-value font-mono">
              Length: {formatDimension(distance(selectedWall.start, selectedWall.end), state.unit)}
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">Wall Thickness</label>
            <div className="flex gap-2">
              {[10, 15, 20].map((t) => (
                <button
                  key={t}
                  className={`btn-secondary flex-1 ${selectedWall.thickness === t ? 'active' : ''}`}
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      walls: prev.walls.map((w) =>
                        w.id === selectedWall.id ? { ...w, thickness: t } : w
                      ),
                    }))
                  }
                >
                  {t} cm
                </button>
              ))}
            </div>
          </div>

          <button className="btn-danger w-full mt-4" onClick={handleDelete}>
            <Trash2 size={15} />
            <span>Delete Wall</span>
          </button>
        </div>
      )}

      {/* Selected Door Inspector */}
      {selectedDoor && (
        <div className="inspector-content">
          <div className="info-card">
            <span className="info-title">Door Fixture</span>
            <span className="info-value font-mono">
              Width: {formatDimension(selectedDoor.width, state.unit)}
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">Door Width</label>
            <div className="flex gap-2">
              {[70, 80, 90].map((w) => (
                <button
                  key={w}
                  className={`btn-secondary flex-1 ${selectedDoor.width === w ? 'active' : ''}`}
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      doors: prev.doors.map((d) =>
                        d.id === selectedDoor.id ? { ...d, width: w } : d
                      ),
                    }))
                  }
                >
                  {w} cm
                </button>
              ))}
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Orientation</label>
            <button className="btn-secondary w-full" onClick={() => handleRotate(90)}>
              <RotateCw size={15} />
              <span>Rotate 90°</span>
            </button>
          </div>

          <button className="btn-danger w-full mt-4" onClick={handleDelete}>
            <Trash2 size={15} />
            <span>Delete Door</span>
          </button>
        </div>
      )}

      {/* Selected Window Inspector */}
      {selectedWindow && (
        <div className="inspector-content">
          <div className="info-card">
            <span className="info-title">Window Element</span>
            <span className="info-value font-mono">
              Width: {formatDimension(selectedWindow.width, state.unit)}
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">Window Width</label>
            <div className="flex gap-2">
              {[100, 140, 180].map((w) => (
                <button
                  key={w}
                  className={`btn-secondary flex-1 ${selectedWindow.width === w ? 'active' : ''}`}
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      windows: prev.windows.map((win) =>
                        win.id === selectedWindow.id ? { ...win, width: w } : win
                      ),
                    }))
                  }
                >
                  {w} cm
                </button>
              ))}
            </div>
          </div>

          <button className="btn-secondary w-full" onClick={() => handleRotate(90)}>
            <RotateCw size={15} />
            <span>Rotate 90°</span>
          </button>

          <button className="btn-danger w-full mt-4" onClick={handleDelete}>
            <Trash2 size={15} />
            <span>Delete Window</span>
          </button>
        </div>
      )}

      {/* Empty State */}
      {!selectedId && (
        <div className="inspector-empty">
          <Info size={28} className="text-slate-400 mb-2" />
          <h4 className="text-sm font-semibold text-slate-700">No Item Selected</h4>
          <p className="text-xs text-slate-500 mt-1 text-center leading-relaxed">
            Select any furniture, wall, door, or window on the canvas to inspect dimensions, rotate,
            or customize colors.
          </p>

          <div className="stats-box mt-6">
            <span className="stats-header">Floorplan Stats</span>
            <div className="stats-row">
              <span>Walls:</span>
              <span className="font-mono font-semibold">{state.walls.length}</span>
            </div>
            <div className="stats-row">
              <span>Furniture Items:</span>
              <span className="font-mono font-semibold">{state.furniture.length}</span>
            </div>
            <div className="stats-row">
              <span>Doors:</span>
              <span className="font-mono font-semibold">{state.doors.length}</span>
            </div>
            <div className="stats-row">
              <span>Windows:</span>
              <span className="font-mono font-semibold">{state.windows.length}</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
