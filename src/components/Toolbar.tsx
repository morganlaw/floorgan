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
  Scaling,
  Undo2,
  Redo2,
  Type,
  HelpCircle,
  Upload,
} from 'lucide-react';
import { FloorplanState, ToolMode, Unit } from '../types';
import { TEMPLATES } from '../templates';

interface Props {
  tool: ToolMode;
  setTool: (tool: ToolMode) => void;
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setSelectedId: (id: string | null) => void;
  setSelectedType: (type: any) => void;
  onOpenImportModal: () => void;
  onOpenShortcuts?: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const Toolbar: React.FC<Props> = ({
  tool,
  setTool,
  state,
  setState,
  setZoom,
  setPan,
  setSelectedId,
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

  const handleTemplateLoad = (key: string) => {
    if (key === 'clear') {
      if (window.confirm('Clear current floorplan?')) {
        setState({
          walls: [],
          doors: [],
          windows: [],
          furniture: [],
          measurements: [],
          unit: 'm',
          gridSnap: true,
          gridSize: 20,
        });
        setSelectedId(null);
        setSelectedType(null);
      }
      return;
    }

    if (TEMPLATES[key]) {
      setState(TEMPLATES[key].state);
      setSelectedId(null);
      setSelectedType(null);
      setZoom(1.0);
      setPan({ x: 200, y: 150 });
    }
  };

  return (
    <header className="toolbar">
      {/* Brand */}
      <div className="brand">
        <span className="brand-logo">📐</span>
        <h1 className="brand-title">Floorgan</h1>
      </div>

      {/* Primary Feature: Import Floorplan */}
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

      {/* Primary Tool Selector */}
      <div className="tool-group">
        <button
          className={`tool-btn ${tool === 'select' ? 'active' : ''}`}
          onClick={() => setTool('select')}
          title="Select & Move (V)"
        >
          <MousePointer size={18} />
          <span>Select</span>
        </button>

        <button
          className={`tool-btn ${tool === 'wall' ? 'active' : ''}`}
          onClick={() => setTool('wall')}
          title="Draw Walls (W) — Click to start, click to end, ESC to cancel"
        >
          <Square size={18} />
          <span>Wall</span>
        </button>

        <button
          className={`tool-btn ${tool === 'door' ? 'active' : ''}`}
          onClick={() => setTool('door')}
          title="Draw Door (D) — Click or drag along wall to draft door opening"
        >
          <DoorOpen size={18} />
          <span>Door</span>
        </button>

        <button
          className={`tool-btn ${tool === 'window' ? 'active' : ''}`}
          onClick={() => setTool('window')}
          title="Draw Window — Click or drag along wall to draft window opening"
        >
          <AppWindow size={18} />
          <span>Window</span>
        </button>

        <button
          className={`tool-btn ${tool === 'text' ? 'active' : ''}`}
          onClick={() => setTool('text')}
          title="Text Box (T) — Click canvas to place a custom text box"
        >
          <Type size={18} />
          <span>Text</span>
        </button>

        <button
          className={`tool-btn ${tool === 'measure' ? 'active' : ''}`}
          onClick={() => setTool('measure')}
          title="Measuring Tape (M)"
        >
          <Ruler size={18} />
          <span>Measure</span>
        </button>

        <button
          className={`tool-btn ${tool === 'calibrate' ? 'active' : ''}`}
          onClick={() => setTool('calibrate')}
          title="Calibrate Real-World Scale — Click two points on a wall and enter its length"
        >
          <Scaling size={18} />
          <span>Calibrate</span>
        </button>

        <button
          className={`tool-btn ${tool === 'pan' ? 'active' : ''}`}
          onClick={() => setTool('pan')}
          title="Pan View (H / Middle Mouse)"
        >
          <Hand size={18} />
          <span>Pan</span>
        </button>
      </div>

      <div className="divider-vertical" />

      {/* Undo & Redo History Controls */}
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

      {/* Grid Snap & Unit Toggle */}
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

      {/* View Zoom Controls */}
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

      {/* Right Group: Compact Template Loader & Shortcuts */}
      <div className="tool-group-right">
        <select
          className="select-dropdown select-dropdown-sm"
          onChange={(e) => {
            handleTemplateLoad(e.target.value);
            e.target.value = '';
          }}
          defaultValue=""
          title="Load starter template"
        >
          <option value="" disabled>
            Template...
          </option>
          <option value="studio">Studio Apt</option>
          <option value="one_bedroom">1-Bed Flat</option>
          <option value="clear">Clear Canvas</option>
        </select>

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
