import React, { useState, useEffect } from 'react';
import {
  MousePointer,
  Square,
  DoorOpen,
  AppWindow,
  Ruler,
  Hand,
  Magnet,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Undo2,
  Redo2,
  Type,
  HelpCircle,
  Upload,
  Trash2,
} from 'lucide-react';
import { FloorplanState, SelectedElementType, ToolMode, Unit } from '../types';

interface ToolbarProps {
  tool: ToolMode;
  setTool: (tool: ToolMode) => void;
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setSelectedId: (id: string | null) => void;
  setSelectedIds?: (ids: string[]) => void;
  setSelectedType: (type: SelectedElementType) => void;
  onOpenImportModal: () => void;
  onOpenShortcuts?: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  tool,
  setTool,
  state,
  setState,
  setZoom,
  setPan,
  setSelectedId,
  setSelectedIds,
  setSelectedType,
  onOpenImportModal,
  onOpenShortcuts,
  undo,
  redo,
  canUndo,
  canRedo,
}) => {
  const [showImportHint, setShowImportHint] = useState(true);

  useEffect(() => {
    if (!showImportHint) return;

    const handleDismiss = () => {
      setShowImportHint(false);
    };

    window.addEventListener('pointerdown', handleDismiss, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', handleDismiss, { capture: true });
    };
  }, [showImportHint]);

  const handleUnitToggle = (unit: Unit) => {
    setState((prev) => ({ ...prev, unit }));
  };

  const handleSnapToggle = () => {
    setState((prev) => ({ ...prev, gridSnap: !prev.gridSnap }));
  };

  const isCanvasEmpty =
    state.walls.length === 0 &&
    state.doors.length === 0 &&
    state.windows.length === 0 &&
    state.furniture.length === 0 &&
    state.measurements.length === 0 &&
    (!state.textBoxes || state.textBoxes.length === 0) &&
    (!state.roomLabels || state.roomLabels.length === 0) &&
    !state.background;

  const handleClearCanvas = () => {
    if (isCanvasEmpty) return;

    if (window.confirm('Clear canvas? All walls, furniture, and measurements will be removed.')) {
      setState((prev) => ({
        ...prev,
        walls: [],
        doors: [],
        windows: [],
        furniture: [],
        measurements: [],
        textBoxes: [],
        roomLabels: [],
        background: null,
      }));
      setSelectedId(null);
      setSelectedIds?.([]);
      setSelectedType(null);
    }
  };

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-logo">📐</span>
        <h1 className="brand-title">Floorgan</h1>
      </div>

      <div className="import-btn-container">
        <button
          className="tool-btn import-highlight-btn"
          onClick={onOpenImportModal}
          title="Import floorplan from image upload or website URL"
        >
          <Upload size={16} />
          <span>Import Floorplan</span>
        </button>

        {showImportHint && (
          <div
            className="import-indicator-callout"
            onPointerDown={() => onOpenImportModal()}
            role="tooltip"
          >
            <div className="import-indicator-arrow" />
            <div className="import-indicator-inner">
              <div className="import-indicator-text">
                Generate a floorplan from an image
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="divider-vertical" />

      <div className="tool-group">
        <button
          className={`tool-btn ${tool === 'select' ? 'active' : ''}`}
          onClick={() => setTool('select')}
          title="Select & Move (V or 1)"
        >
          <MousePointer size={18} />
          <span>Select</span>
        </button>

        <button
          className={`tool-btn ${tool === 'wall' ? 'active' : ''}`}
          onClick={() => setTool('wall')}
          title="Draw Walls (2 or Shift+W) — Click to start, click to end, ESC to cancel"
        >
          <Square size={18} />
          <span>Wall</span>
        </button>

        <button
          className={`tool-btn ${tool === 'door' ? 'active' : ''}`}
          onClick={() => setTool('door')}
          title="Draw Door (3 or Shift+D) — Click or drag along wall to draft door opening"
        >
          <DoorOpen size={18} />
          <span>Door</span>
        </button>

        <button
          className={`tool-btn ${tool === 'window' ? 'active' : ''}`}
          onClick={() => setTool('window')}
          title="Draw Window (4) — Click or drag along wall to draft window opening"
        >
          <AppWindow size={18} />
          <span>Window</span>
        </button>

        <button
          className={`tool-btn ${tool === 'text' ? 'active' : ''}`}
          onClick={() => setTool('text')}
          title="Text Box (T or 5) — Click canvas to place a custom text box"
        >
          <Type size={18} />
          <span>Text</span>
        </button>

        <button
          className={`tool-btn ${tool === 'measure' ? 'active' : ''}`}
          onClick={() => setTool('measure')}
          title="Measuring Tape (M or 6)"
        >
          <Ruler size={18} />
          <span>Measure</span>
        </button>

        <button
          className={`tool-btn ${tool === 'pan' ? 'active' : ''}`}
          onClick={() => setTool('pan')}
          title="Pan View (H or 7 / Space / WASD)"
        >
          <Hand size={18} />
          <span>Pan</span>
        </button>
      </div>

      <div className="divider-vertical" />

      <div className="tool-group">
        <button
          className="tool-btn"
          onClick={undo}
          disabled={!canUndo}
          title="Undo last action (Ctrl+Z / Cmd+Z)"
        >
          <Undo2 size={18} />
          <span>Undo</span>
        </button>

        <button
          className="tool-btn"
          onClick={redo}
          disabled={!canRedo}
          title="Redo action (Ctrl+Y / Cmd+Shift+Z)"
        >
          <Redo2 size={18} />
          <span>Redo</span>
        </button>
      </div>

      <div className="tool-group">
        <button
          className={`tool-btn ${state.gridSnap ? 'active' : ''}`}
          onClick={handleSnapToggle}
          title="Toggle Grid Snapping"
        >
          <Magnet size={18} />
          <span>Snap</span>
        </button>

        <div className="segmented-control">
          <button
            className={`segment-btn ${state.unit === 'm' ? 'active' : ''}`}
            onClick={() => handleUnitToggle('m')}
          >
            Meters
          </button>
          <button
            className={`segment-btn ${state.unit === 'ft' ? 'active' : ''}`}
            onClick={() => handleUnitToggle('ft')}
          >
            Feet
          </button>
        </div>
      </div>

      <div className="divider-vertical" />

      <div className="tool-group">
        <button
          className="tool-btn-icon"
          onClick={() => setZoom((z) => Math.min(z * 1.2, 4.0))}
          title="Zoom In"
        >
          <ZoomIn size={18} />
        </button>
        <button
          className="tool-btn-icon"
          onClick={() => setZoom((z) => Math.max(z * 0.8, 0.2))}
          title="Zoom Out"
        >
          <ZoomOut size={18} />
        </button>
        <button
          className="tool-btn-icon"
          onClick={() => {
            setZoom(1.0);
            setPan({ x: 200, y: 150 });
          }}
          title="Reset View"
        >
          <RotateCcw size={16} />
        </button>
      </div>

      <div className="tool-group-right">
        <button
          type="button"
          className="tool-btn-icon danger"
          onClick={handleClearCanvas}
          disabled={isCanvasEmpty}
          title={isCanvasEmpty ? 'Canvas is empty' : 'Clear Canvas'}
          aria-label="Clear Canvas"
        >
          <Trash2 size={16} />
        </button>

        {onOpenShortcuts && (
          <button
            className="tool-btn-icon"
            onClick={onOpenShortcuts}
            title="Keyboard shortcuts & guide"
          >
            <HelpCircle size={18} />
          </button>
        )}
      </div>
    </header>
  );
};
