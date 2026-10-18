import React, { useState } from 'react';
import {
  RotateCw,
  Copy,
  Trash2,
  ArrowUp,
  ArrowDown,
  Info,
  Eye,
  EyeOff,
  Ruler,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  Italic,
  Type,
  X,
  Layers,
} from 'lucide-react';
import { CustomShapeKind, FloorplanState, PlacedFurniture, SelectedElementType, TextBoxItem, ToolMode, Unit } from '../types';
import { formatDimension, distance } from '../utils/geometry';
import { BASIC_SHAPES } from '../utils/shapes';

const PropDimInput: React.FC<{
  label: string;
  valueCm: number;
  unit: Unit;
  minCm?: number;
  onChange: (cm: number) => void;
}> = ({ label, valueCm, unit, minCm = 5, onChange }) => {
  const [draft, setDraft] = useState<string | null>(null);

  const displayVal = unit === 'm' ? valueCm / 100 : valueCm / 30.48;
  const formattedVal = displayVal.toFixed(2);

  const commit = (raw: string) => {
    const clean = raw.trim().replace(',', '.');
    const v = parseFloat(clean);
    if (!isNaN(v) && v > 0) {
      const cm = unit === 'm' ? v * 100 : v * 30.48;
      onChange(Math.max(minCm, Math.round(cm)));
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
        onFocus={() => setDraft(formattedVal)}
        onChange={(e) => {
          const val = e.target.value;
          setDraft(val);
          const clean = val.trim().replace(',', '.');
          const v = parseFloat(clean);
          if (!isNaN(v) && v > 0 && !val.endsWith('.') && !val.endsWith(',')) {
            const cm = unit === 'm' ? v * 100 : v * 30.48;
            onChange(Math.max(minCm, Math.round(cm)));
          }
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const step = unit === 'm' ? 0.05 : 0.25;
            const cur = parseFloat((draft ?? formattedVal).replace(',', '.')) || displayVal;
            const next = cur + step;
            const cm = unit === 'm' ? next * 100 : next * 30.48;
            onChange(Math.max(minCm, Math.round(cm)));
            setDraft(next.toFixed(2));
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const step = unit === 'm' ? 0.05 : 0.25;
            const cur = parseFloat((draft ?? formattedVal).replace(',', '.')) || displayVal;
            const next = Math.max(unit === 'm' ? minCm / 100 : minCm / 30.48, cur - step);
            const cm = unit === 'm' ? next * 100 : next * 30.48;
            onChange(Math.max(minCm, Math.round(cm)));
            setDraft(next.toFixed(2));
          }
        }}
      />
    </div>
  );
};

interface Props {
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedIds?: string[];
  setSelectedIds?: (ids: string[]) => void;
  selectedType: SelectedElementType;
  setSelectedType: (type: SelectedElementType) => void;
  setTool?: (tool: ToolMode) => void;
}

export const PropertiesPanel: React.FC<Props> = ({
  state,
  setState,
  selectedId,
  setSelectedId,
  selectedIds = [],
  setSelectedIds,
  selectedType,
  setSelectedType,
  setTool,
}) => {
  const selectedFurniture = state.furniture.find((f) => f.id === selectedId);
  const selectedWall = state.walls.find((w) => w.id === selectedId);
  const selectedDoor = state.doors.find((d) => d.id === selectedId);
  const selectedWindow = state.windows.find((w) => w.id === selectedId);
  const selectedMeasurement = state.measurements.find((m) => m.id === selectedId);
  const selectedTextBox = (state.textBoxes || []).find((t) => t.id === selectedId);

  const isMultiSelect = selectedIds.length > 1;
  const selectedFurnitureCount = state.furniture.filter((f) => selectedIds.includes(f.id)).length;
  const selectedWallsCount = state.walls.filter((w) => selectedIds.includes(w.id)).length;
  const selectedDoorsCount = state.doors.filter((d) => selectedIds.includes(d.id)).length;
  const selectedWindowsCount = state.windows.filter((w) => selectedIds.includes(w.id)).length;
  const selectedTextBoxesCount = (state.textBoxes || []).filter((t) => selectedIds.includes(t.id)).length;
  const selectedMeasurementsCount = state.measurements.filter((m) => selectedIds.includes(m.id)).length;

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

  // Text box handlers
  const updateTextBox = (updates: Partial<TextBoxItem>) => {
    if (!selectedId) return;
    setState((prev) => ({
      ...prev,
      textBoxes: (prev.textBoxes || []).map((t) => (t.id === selectedId ? { ...t, ...updates } : t)),
    }));
  };

  const handleRotate = (deltaDegrees: number) => {
    if (selectedFurniture) {
      const nextRotation = (selectedFurniture.rotation + deltaDegrees + 360) % 360;
      updateFurniture({ rotation: nextRotation });
    } else if (selectedTextBox) {
      updateTextBox({ rotation: (selectedTextBox.rotation + deltaDegrees + 360) % 360 });
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
    } else if (selectedWall) {
      const midX = (selectedWall.start.x + selectedWall.end.x) / 2;
      const midY = (selectedWall.start.y + selectedWall.end.y) / 2;
      const len = distance(selectedWall.start, selectedWall.end);
      const currentAngle = Math.atan2(
        selectedWall.end.y - selectedWall.start.y,
        selectedWall.end.x - selectedWall.start.x
      );
      const nextAngle = currentAngle + (deltaDegrees * Math.PI) / 180;
      const half = len / 2;
      const newStart = {
        x: Math.round(midX - half * Math.cos(nextAngle)),
        y: Math.round(midY - half * Math.sin(nextAngle)),
      };
      const newEnd = {
        x: Math.round(midX + half * Math.cos(nextAngle)),
        y: Math.round(midY + half * Math.sin(nextAngle)),
      };
      setState((prev) => ({
        ...prev,
        walls: prev.walls.map((w) =>
          w.id === selectedId ? { ...w, start: newStart, end: newEnd } : w
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
      setSelectedIds?.([copy.id]);
    } else if (selectedTextBox) {
      const copy: TextBoxItem = {
        ...selectedTextBox,
        id: 'text_' + Date.now(),
        x: selectedTextBox.x + 20,
        y: selectedTextBox.y + 20,
      };
      setState((prev) => ({ ...prev, textBoxes: [...(prev.textBoxes || []), copy] }));
      setSelectedId(copy.id);
      setSelectedIds?.([copy.id]);
    } else if (selectedWall) {
      const copy = {
        ...selectedWall,
        id: 'wall_' + Date.now(),
        start: { x: selectedWall.start.x + 20, y: selectedWall.start.y + 20 },
        end: { x: selectedWall.end.x + 20, y: selectedWall.end.y + 20 },
      };
      setState((prev) => ({ ...prev, walls: [...prev.walls, copy] }));
      setSelectedId(copy.id);
      setSelectedIds?.([copy.id]);
    }
  };

  const handleBatchDuplicate = () => {
    if (selectedIds.length <= 1) return;
    const newSelectedIds: string[] = [];

    setState((prev) => {
      const nextFurniture = [...prev.furniture];
      const nextTextBoxes = [...(prev.textBoxes || [])];
      const nextWalls = [...prev.walls];
      const nextDoors = [...prev.doors];
      const nextWindows = [...prev.windows];
      const nextMeasurements = [...prev.measurements];

      // Duplicate furniture
      prev.furniture.forEach((f, idx) => {
        if (selectedIds.includes(f.id)) {
          const newId = `furn_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`;
          newSelectedIds.push(newId);
          nextFurniture.push({
            ...f,
            id: newId,
            x: f.x + 20,
            y: f.y + 20,
          });
        }
      });

      // Duplicate text boxes
      (prev.textBoxes || []).forEach((t, idx) => {
        if (selectedIds.includes(t.id)) {
          const newId = `text_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`;
          newSelectedIds.push(newId);
          nextTextBoxes.push({
            ...t,
            id: newId,
            x: t.x + 20,
            y: t.y + 20,
          });
        }
      });

      // Duplicate walls
      prev.walls.forEach((w, idx) => {
        if (selectedIds.includes(w.id)) {
          const newId = `wall_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`;
          newSelectedIds.push(newId);
          nextWalls.push({
            ...w,
            id: newId,
            start: { x: w.start.x + 20, y: w.start.y + 20 },
            end: { x: w.end.x + 20, y: w.end.y + 20 },
          });
        }
      });

      // Duplicate doors
      prev.doors.forEach((d, idx) => {
        if (selectedIds.includes(d.id)) {
          const newId = `door_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`;
          newSelectedIds.push(newId);
          nextDoors.push({
            ...d,
            id: newId,
            x: d.x + 20,
            y: d.y + 20,
          });
        }
      });

      // Duplicate windows
      prev.windows.forEach((win, idx) => {
        if (selectedIds.includes(win.id)) {
          const newId = `win_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`;
          newSelectedIds.push(newId);
          nextWindows.push({
            ...win,
            id: newId,
            x: win.x + 20,
            y: win.y + 20,
          });
        }
      });

      // Duplicate measurements
      prev.measurements.forEach((m, idx) => {
        if (selectedIds.includes(m.id)) {
          const newId = `meas_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`;
          newSelectedIds.push(newId);
          nextMeasurements.push({
            ...m,
            id: newId,
            start: { x: m.start.x + 20, y: m.start.y + 20 },
            end: { x: m.end.x + 20, y: m.end.y + 20 },
          });
        }
      });

      return {
        ...prev,
        furniture: nextFurniture,
        textBoxes: nextTextBoxes,
        walls: nextWalls,
        doors: nextDoors,
        windows: nextWindows,
        measurements: nextMeasurements,
      };
    });

    if (newSelectedIds.length > 0) {
      setSelectedIds?.(newSelectedIds);
      setSelectedId(newSelectedIds[0]);
      setSelectedType('multiple');
    }
  };

  const handleBatchDelete = () => {
    setState((prev) => ({
      ...prev,
      furniture: prev.furniture.filter((f) => !selectedIds.includes(f.id)),
      textBoxes: (prev.textBoxes || []).filter((t) => !selectedIds.includes(t.id)),
      walls: prev.walls.filter((w) => !selectedIds.includes(w.id)),
      doors: prev.doors.filter((d) => !selectedIds.includes(d.id)),
      windows: prev.windows.filter((w) => !selectedIds.includes(w.id)),
      measurements: prev.measurements.filter((m) => !selectedIds.includes(m.id)),
    }));
    setSelectedId(null);
    setSelectedType(null);
    setSelectedIds?.([]);
  };

  const handleDelete = () => {
    if (!selectedId) return;
    if (selectedType === 'furniture') {
      setState((prev) => ({
        ...prev,
        furniture: prev.furniture.filter((f) => f.id !== selectedId),
      }));
    } else if (selectedType === 'textbox') {
      setState((prev) => ({
        ...prev,
        textBoxes: (prev.textBoxes || []).filter((t) => t.id !== selectedId),
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
    setSelectedIds?.([]);
  };

  const handleReorder = (direction: 'front' | 'back') => {
    if (selectedFurniture) {
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
    } else if (selectedTextBox) {
      setState((prev) => {
        const list = [...(prev.textBoxes || [])];
        const index = list.findIndex((t) => t.id === selectedTextBox.id);
        if (index === -1) return prev;
        const [item] = list.splice(index, 1);
        if (direction === 'front') {
          list.push(item);
        } else {
          list.unshift(item);
        }
        return { ...prev, textBoxes: list };
      });
    }
  };

  return (
    <aside className="properties-panel">
      <div className="panel-header">
        <h3 className="panel-title">Inspector</h3>
      </div>

      {/* Multi-Selection Inspector */}
      {isMultiSelect && (
        <div className="inspector-content">
          <div className="info-card">
            <div className="flex justify-between items-center mb-1">
              <span className="info-title">Multiple Items Selected</span>
              <span className="custom-tag flex items-center gap-1">
                <Layers size={11} />
                <span>Multi-Select</span>
              </span>
            </div>
            <span className="info-value font-mono">
              {selectedIds.length} items selected
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">Selected Elements</label>
            <div className="stats-box">
              {selectedFurnitureCount > 0 && (
                <div className="stats-row">
                  <span>Furniture:</span>
                  <span className="font-mono font-semibold">{selectedFurnitureCount}</span>
                </div>
              )}
              {selectedWallsCount > 0 && (
                <div className="stats-row">
                  <span>Wall Segments:</span>
                  <span className="font-mono font-semibold">{selectedWallsCount}</span>
                </div>
              )}
              {selectedDoorsCount > 0 && (
                <div className="stats-row">
                  <span>Doors:</span>
                  <span className="font-mono font-semibold">{selectedDoorsCount}</span>
                </div>
              )}
              {selectedWindowsCount > 0 && (
                <div className="stats-row">
                  <span>Windows:</span>
                  <span className="font-mono font-semibold">{selectedWindowsCount}</span>
                </div>
              )}
              {selectedTextBoxesCount > 0 && (
                <div className="stats-row">
                  <span>Text Boxes:</span>
                  <span className="font-mono font-semibold">{selectedTextBoxesCount}</span>
                </div>
              )}
              {selectedMeasurementsCount > 0 && (
                <div className="stats-row">
                  <span>Measurements:</span>
                  <span className="font-mono font-semibold">{selectedMeasurementsCount}</span>
                </div>
              )}
            </div>
          </div>

          <div className="divider" />

          {/* Batch Actions */}
          <div className="flex flex-col gap-2">
            <button
              className="btn-secondary w-full"
              onClick={handleBatchDuplicate}
              title="Duplicate all selected items"
            >
              <Copy size={15} />
              <span>Duplicate Selected ({selectedIds.length})</span>
            </button>
            <button
              className="btn-danger w-full"
              onClick={handleBatchDelete}
              title="Delete all selected items"
            >
              <Trash2 size={15} />
              <span>Delete Selected ({selectedIds.length})</span>
            </button>
            <button
              className="btn-secondary w-full"
              onClick={() => {
                setSelectedId(null);
                setSelectedType(null);
                setSelectedIds?.([]);
              }}
              title="Deselect all items"
            >
              <X size={15} />
              <span>Deselect All</span>
            </button>
          </div>
        </div>
      )}

      {/* Selected Furniture Inspector */}
      {!isMultiSelect && selectedFurniture && (
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

          {/* Custom object shape */}
          {selectedFurniture.shape && (
            <div className="field-group">
              <label className="field-label">
                Shape <span className="custom-tag">Custom</span>
              </label>
              {selectedFurniture.shape === 'polygon' ? (
                <span className="info-value">Freeform outline ({selectedFurniture.points?.length ?? 0} corners)</span>
              ) : (
                <select
                  className="select-dropdown"
                  value={selectedFurniture.shape}
                  onChange={(e) => updateFurniture({ shape: e.target.value as CustomShapeKind })}
                >
                  {BASIC_SHAPES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Dimensions */}
          <div className="field-row">
            <PropDimInput
              label="Width"
              valueCm={selectedFurniture.width}
              unit={state.unit}
              minCm={10}
              onChange={(w) => updateFurniture({ width: w })}
            />
            <PropDimInput
              label="Depth"
              valueCm={selectedFurniture.depth}
              unit={state.unit}
              minCm={10}
              onChange={(d) => updateFurniture({ depth: d })}
            />
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

      {/* Selected Text Box Inspector */}
      {!isMultiSelect && selectedTextBox && (
        <div className="inspector-content">
          <div className="field-group">
            <div className="flex justify-between items-center mb-1">
              <label className="field-label">Text Content</label>
              <span className="custom-tag flex items-center gap-1">
                <Type size={11} />
                <span>Text Box</span>
              </span>
            </div>
            <textarea
              rows={3}
              value={selectedTextBox.text}
              onChange={(e) => updateTextBox({ text: e.target.value })}
              className="field-input font-sans text-sm"
              placeholder="Enter text..."
              autoFocus
            />
          </div>

          {/* Typography & Style controls */}
          <div className="field-group">
            <label className="field-label">Typography</label>
            <div className="flex gap-2 items-center">
              <div className="flex items-center gap-1 flex-1">
                <span className="text-xs text-slate-500">Size:</span>
                <input
                  type="number"
                  min="8"
                  max="96"
                  step="2"
                  value={selectedTextBox.fontSize || 16}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v) && v > 0) updateTextBox({ fontSize: v });
                  }}
                  className="field-input w-16"
                />
                <span className="text-xs text-slate-400">px</span>
              </div>

              <div className="flex gap-1 items-center">
                <button
                  className={`tool-btn-icon ${selectedTextBox.bold ? 'active' : ''}`}
                  onClick={() => updateTextBox({ bold: !selectedTextBox.bold })}
                  title="Toggle Bold"
                >
                  <Bold size={14} />
                </button>
                <button
                  className={`tool-btn-icon ${selectedTextBox.italic ? 'active' : ''}`}
                  onClick={() => updateTextBox({ italic: !selectedTextBox.italic })}
                  title="Toggle Italic"
                >
                  <Italic size={14} />
                </button>
              </div>
            </div>
          </div>

          {/* Alignment */}
          <div className="field-group">
            <label className="field-label">Alignment</label>
            <div className="segmented-control">
              <button
                className={`segment-btn flex-1 ${(selectedTextBox.textAlign || 'center') === 'left' ? 'active' : ''}`}
                onClick={() => updateTextBox({ textAlign: 'left' })}
                title="Align Left"
              >
                <AlignLeft size={14} />
              </button>
              <button
                className={`segment-btn flex-1 ${(selectedTextBox.textAlign || 'center') === 'center' ? 'active' : ''}`}
                onClick={() => updateTextBox({ textAlign: 'center' })}
                title="Align Center"
              >
                <AlignCenter size={14} />
              </button>
              <button
                className={`segment-btn flex-1 ${(selectedTextBox.textAlign || 'center') === 'right' ? 'active' : ''}`}
                onClick={() => updateTextBox({ textAlign: 'right' })}
                title="Align Right"
              >
                <AlignRight size={14} />
              </button>
            </div>
          </div>

          {/* Text Color */}
          <div className="field-group">
            <label className="field-label">Text Color</label>
            <div className="color-palette">
              {['#0f172a', '#475569', '#2563eb', '#0284c7', '#0f766e', '#16a34a', '#b45309', '#dc2626', '#ffffff'].map((c) => (
                <button
                  key={c}
                  className={`color-swatch ${selectedTextBox.color === c ? 'selected' : ''}`}
                  style={{ backgroundColor: c, border: c === '#ffffff' ? '1px solid #cbd5e1' : undefined }}
                  onClick={() => updateTextBox({ color: c })}
                />
              ))}
            </div>
          </div>

          {/* Background Fill */}
          <div className="field-group">
            <label className="field-label">Background Card</label>
            <div className="color-palette">
              {[
                { c: 'transparent', label: 'None' },
                { c: '#ffffff', label: 'White' },
                { c: '#fef08a', label: 'Yellow' },
                { c: '#eff6ff', label: 'Blue' },
                { c: '#f0fdf4', label: 'Green' },
                { c: '#fef2f2', label: 'Red' },
                { c: '#1e293b', label: 'Dark' },
              ].map(({ c, label }) => (
                <button
                  key={c}
                  className={`color-swatch ${selectedTextBox.backgroundColor === c ? 'selected' : ''}`}
                  style={{
                    backgroundColor: c === 'transparent' ? '#ffffff' : c,
                    backgroundImage: c === 'transparent' ? 'linear-gradient(45deg, #ef4444 50%, transparent 50%)' : undefined,
                    border: '1px solid #cbd5e1',
                  }}
                  onClick={() => updateTextBox({ backgroundColor: c })}
                  title={label}
                />
              ))}
            </div>
          </div>

          {/* Border Outline */}
          <div className="field-group">
            <label className="field-label">Border Style</label>
            <div className="segmented-control">
              <button
                className={`segment-btn flex-1 ${(selectedTextBox.borderStyle || 'solid') === 'none' ? 'active' : ''}`}
                onClick={() => updateTextBox({ borderStyle: 'none' })}
              >
                None
              </button>
              <button
                className={`segment-btn flex-1 ${(selectedTextBox.borderStyle || 'solid') === 'solid' ? 'active' : ''}`}
                onClick={() => updateTextBox({ borderStyle: 'solid' })}
              >
                Solid
              </button>
              <button
                className={`segment-btn flex-1 ${selectedTextBox.borderStyle === 'dashed' ? 'active' : ''}`}
                onClick={() => updateTextBox({ borderStyle: 'dashed' })}
              >
                Dashed
              </button>
            </div>
          </div>

          {/* Dimensions & Resizing */}
          <div className="field-group">
            <div className="flex justify-between items-center mb-1">
              <label className="field-label mb-0">Dimensions</label>
              <button
                className="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                onClick={() => {
                  const rawLines = (selectedTextBox.text || '').split('\n');
                  const maxLineLen = Math.max(...rawLines.map((l) => l.length), 4);
                  const fontSize = selectedTextBox.fontSize || 16;
                  const lineCount = Math.max(rawLines.length, 1);
                  const fittedW = Math.max(60, Math.round(maxLineLen * fontSize * 0.65 + 30));
                  const fittedH = Math.max(30, Math.round(lineCount * fontSize * 1.35 + 20));
                  updateTextBox({ width: fittedW, height: fittedH });
                }}
                title="Automatically resize box to fit text content"
              >
                Auto-fit to Text
              </button>
            </div>
            <div className="field-row">
              <PropDimInput
                label="Width"
                valueCm={selectedTextBox.width}
                unit={state.unit}
                minCm={15}
                onChange={(w) => updateTextBox({ width: w })}
              />
              <PropDimInput
                label="Height"
                valueCm={selectedTextBox.height}
                unit={state.unit}
                minCm={15}
                onChange={(h) => updateTextBox({ height: h })}
              />
            </div>
            {/* Quick Size Presets */}
            <div className="flex gap-1 mt-1">
              {[
                { label: 'Small', w: 100, h: 40 },
                { label: 'Medium', w: 140, h: 55 },
                { label: 'Large', w: 200, h: 70 },
                { label: 'Card', w: 180, h: 110 },
              ].map((p) => (
                <button
                  key={p.label}
                  className="btn-secondary text-[11px] py-1 px-1 flex-1 text-center"
                  onClick={() => updateTextBox({ width: p.w, height: p.h })}
                  title={`Resize to ${formatDimension(p.w, state.unit)} × ${formatDimension(p.h, state.unit)}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Rotation Control */}
          <div className="field-group">
            <div className="flex justify-between items-center mb-1">
              <label className="field-label">Rotation</label>
              <span className="text-xs font-mono font-bold text-blue-600">
                {selectedTextBox.rotation}°
              </span>
            </div>
            <div className="flex gap-2 items-center">
              <input
                type="range"
                min="0"
                max="359"
                value={selectedTextBox.rotation}
                onChange={(e) => updateTextBox({ rotation: parseInt(e.target.value) })}
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
      {!isMultiSelect && selectedWall && (() => {
        const wallLen = distance(selectedWall.start, selectedWall.end);
        const angleRad = Math.atan2(
          selectedWall.end.y - selectedWall.start.y,
          selectedWall.end.x - selectedWall.start.x
        );
        let angleDeg = Math.round((angleRad * 180) / Math.PI);
        if (angleDeg < 0) angleDeg += 360;

        return (
          <div className="inspector-content">
            <div className="info-card">
              <span className="info-title">Wall Segment</span>
              <span className="info-value font-mono">
                {formatDimension(wallLen, state.unit)} • {angleDeg}°
              </span>
            </div>

            {/* Exact Length Input */}
            <div className="field-group">
              <label className="field-label">Wall Length ({state.unit === 'm' ? 'cm' : 'in'})</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="20"
                  max="5000"
                  value={Math.round(wallLen)}
                  onChange={(e) => {
                    const newLen = parseInt(e.target.value);
                    if (!isNaN(newLen) && newLen >= 15) {
                      const midX = (selectedWall.start.x + selectedWall.end.x) / 2;
                      const midY = (selectedWall.start.y + selectedWall.end.y) / 2;
                      const half = newLen / 2;
                      const cos = Math.cos(angleRad);
                      const sin = Math.sin(angleRad);
                      setState((prev) => ({
                        ...prev,
                        walls: prev.walls.map((w) =>
                          w.id === selectedWall.id
                            ? {
                                ...w,
                                start: { x: Math.round(midX - half * cos), y: Math.round(midY - half * sin) },
                                end: { x: Math.round(midX + half * cos), y: Math.round(midY + half * sin) },
                              }
                            : w
                        ),
                      }));
                    }
                  }}
                  className="field-input flex-1"
                />
                {[100, 200, 300, 400].map((l) => (
                  <button
                    key={l}
                    className={`btn-secondary ${Math.abs(wallLen - l) < 2 ? 'active' : ''}`}
                    onClick={() => {
                      const midX = (selectedWall.start.x + selectedWall.end.x) / 2;
                      const midY = (selectedWall.start.y + selectedWall.end.y) / 2;
                      const half = l / 2;
                      const cos = Math.cos(angleRad);
                      const sin = Math.sin(angleRad);
                      setState((prev) => ({
                        ...prev,
                        walls: prev.walls.map((w) =>
                          w.id === selectedWall.id
                            ? {
                                ...w,
                                start: { x: Math.round(midX - half * cos), y: Math.round(midY - half * sin) },
                                end: { x: Math.round(midX + half * cos), y: Math.round(midY + half * sin) },
                              }
                            : w
                        ),
                      }));
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
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

            {/* Orientation / Rotate Controls */}
            <div className="field-group">
              <label className="field-label">Orientation ({angleDeg}°)</label>
              <div className="flex gap-2">
                <button
                  className="btn-secondary flex-1"
                  onClick={() => handleRotate(90)}
                  title="Rotate 90 degrees clockwise"
                >
                  <RotateCw size={15} />
                  <span>Rotate 90°</span>
                </button>
                <button
                  className="btn-secondary flex-1"
                  onClick={() => handleRotate(45)}
                  title="Rotate 45 degrees clockwise"
                >
                  <RotateCw size={15} />
                  <span>Rotate 45°</span>
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
        );
      })()}

      {/* Selected Door Inspector */}
      {!isMultiSelect && selectedDoor && (
        <div className="inspector-content">
          <div className="info-card">
            <span className="info-title">Door Fixture</span>
            <span className="info-value font-mono">
              Width: {formatDimension(selectedDoor.width, state.unit)}
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">Door Width ({state.unit === 'm' ? 'cm' : 'in'})</label>
            <div className="flex gap-2">
              <input
                type="number"
                min="30"
                max="300"
                value={selectedDoor.width}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val) && val > 0) {
                    setState((prev) => ({
                      ...prev,
                      doors: prev.doors.map((d) =>
                        d.id === selectedDoor.id ? { ...d, width: val } : d
                      ),
                    }));
                  }
                }}
                className="field-input flex-1"
              />
              {[75, 80, 90].map((w) => (
                <button
                  key={w}
                  className={`btn-secondary ${selectedDoor.width === w ? 'active' : ''}`}
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      doors: prev.doors.map((d) =>
                        d.id === selectedDoor.id ? { ...d, width: w } : d
                      ),
                    }))
                  }
                >
                  {w}
                </button>
              ))}
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Swing Side</label>
            <div className="flex gap-2">
              <button
                className={`btn-secondary flex-1 ${selectedDoor.swingDirection !== 'right' ? 'active' : ''}`}
                onClick={() =>
                  setState((prev) => ({
                    ...prev,
                    doors: prev.doors.map((d) =>
                      d.id === selectedDoor.id ? { ...d, swingDirection: 'left' } : d
                    ),
                  }))
                }
              >
                Hinge Left
              </button>
              <button
                className={`btn-secondary flex-1 ${selectedDoor.swingDirection === 'right' ? 'active' : ''}`}
                onClick={() =>
                  setState((prev) => ({
                    ...prev,
                    doors: prev.doors.map((d) =>
                      d.id === selectedDoor.id ? { ...d, swingDirection: 'right' } : d
                    ),
                  }))
                }
              >
                Hinge Right
              </button>
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Orientation ({selectedDoor.rotation}°)</label>
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
      {!isMultiSelect && selectedWindow && (
        <div className="inspector-content">
          <div className="info-card">
            <span className="info-title">Window Element</span>
            <span className="info-value font-mono">
              Width: {formatDimension(selectedWindow.width, state.unit)}
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">Window Width ({state.unit === 'm' ? 'cm' : 'in'})</label>
            <div className="flex gap-2">
              <input
                type="number"
                min="30"
                max="500"
                value={selectedWindow.width}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val) && val > 0) {
                    setState((prev) => ({
                      ...prev,
                      windows: prev.windows.map((win) =>
                        win.id === selectedWindow.id ? { ...win, width: val } : win
                      ),
                    }));
                  }
                }}
                className="field-input flex-1"
              />
              {[100, 140, 180].map((w) => (
                <button
                  key={w}
                  className={`btn-secondary ${selectedWindow.width === w ? 'active' : ''}`}
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      windows: prev.windows.map((win) =>
                        win.id === selectedWindow.id ? { ...win, width: w } : win
                      ),
                    }))
                  }
                >
                  {w}
                </button>
              ))}
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Orientation ({selectedWindow.rotation}°)</label>
            <button className="btn-secondary w-full" onClick={() => handleRotate(90)}>
              <RotateCw size={15} />
              <span>Rotate 90°</span>
            </button>
          </div>

          <button className="btn-danger w-full mt-4" onClick={handleDelete}>
            <Trash2 size={15} />
            <span>Delete Window</span>
          </button>
        </div>
      )}

      {/* Selected Measurement Inspector */}
      {!isMultiSelect && selectedMeasurement && (
        <div className="inspector-content">
          <div className="info-card">
            <span className="info-title">Measurement Dimension</span>
            <span className="info-value font-mono">
              Distance: {formatDimension(distance(selectedMeasurement.start, selectedMeasurement.end), state.unit)}
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">Endpoints</label>
            <span className="text-xs font-mono text-slate-500">
              Start: ({Math.round(selectedMeasurement.start.x)}, {Math.round(selectedMeasurement.start.y)})
            </span>
            <span className="text-xs font-mono text-slate-500">
              End: ({Math.round(selectedMeasurement.end.x)}, {Math.round(selectedMeasurement.end.y)})
            </span>
          </div>

          <button className="btn-danger w-full mt-4" onClick={handleDelete}>
            <Trash2 size={15} />
            <span>Delete Measurement</span>
          </button>
        </div>
      )}

      {/* Empty State */}
      {!isMultiSelect && !selectedId && (
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
            {(state.textBoxes || []).length > 0 && (
              <div className="stats-row">
                <span>Text Boxes:</span>
                <span className="font-mono font-semibold">{(state.textBoxes || []).length}</span>
              </div>
            )}
          </div>

          {state.background && (
            <div className="stats-box mt-4">
              <span className="stats-header">Imported Floorplan Underlay</span>
              <div className="field-group mt-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-600">Opacity</span>
                  <span className="text-xs font-mono font-semibold">
                    {Math.round(state.background.opacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="0.95"
                  step="0.05"
                  value={state.background.opacity}
                  onChange={(e) =>
                    setState((prev) =>
                      prev.background
                        ? {
                            ...prev,
                            background: {
                              ...prev.background,
                              opacity: parseFloat(e.target.value),
                            },
                          }
                        : prev
                    )
                  }
                  className="slider-range"
                />
              </div>

              <div className="flex flex-col gap-2 mt-3">
                <button
                  className="btn-secondary w-full"
                  onClick={() =>
                    setState((prev) =>
                      prev.background
                        ? {
                            ...prev,
                            background: {
                              ...prev.background,
                              visible: !prev.background.visible,
                            },
                          }
                        : prev
                    )
                  }
                >
                  {state.background.visible ? <EyeOff size={14} /> : <Eye size={14} />}
                  <span>{state.background.visible ? 'Hide Underlay' : 'Show Underlay'}</span>
                </button>

                {setTool && (
                  <button
                    className="btn-secondary w-full"
                    onClick={() => setTool('calibrate')}
                  >
                    <Ruler size={14} />
                    <span>Calibrate Scale on Wall</span>
                  </button>
                )}

                <button
                  className="btn-danger w-full"
                  onClick={() => setState((prev) => ({ ...prev, background: null }))}
                >
                  <Trash2 size={14} />
                  <span>Remove Underlay</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
};
