import React from 'react';
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
  Download,
  Upload,
  FileSpreadsheet,
  Trash2,
} from 'lucide-react';
import { FloorplanState, ToolMode, Unit } from '../types';
import { TEMPLATES } from '../templates';
import { exportToJSON, exportSVGToPNG } from '../utils/export';

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
}) => {
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

  const handleImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const loadedState = JSON.parse(event.target?.result as string);
        if (loadedState && Array.isArray(loadedState.walls)) {
          setState(loadedState);
          setSelectedId(null);
          setSelectedType(null);
        }
      } catch (err) {
        alert('Invalid floorplan JSON file.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <header className="toolbar">
      {/* Brand */}
      <div className="brand">
        <span className="brand-logo">📐</span>
        <div>
          <h1 className="brand-title">FloorGAN</h1>
          <span className="brand-sub">Floorplan & Furniture</span>
        </div>
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
          title="Place Door (D)"
        >
          <DoorOpen size={18} />
          <span>Door</span>
        </button>

        <button
          className={`tool-btn ${tool === 'window' ? 'active' : ''}`}
          onClick={() => setTool('window')}
          title="Place Window"
        >
          <AppWindow size={18} />
          <span>Window</span>
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
          className={`tool-btn ${tool === 'pan' ? 'active' : ''}`}
          onClick={() => setTool('pan')}
          title="Pan View (H / Middle Mouse)"
        >
          <Hand size={18} />
          <span>Pan</span>
        </button>
      </div>

      <div className="divider-vertical" />

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

      <div className="divider-vertical" />

      {/* Templates Selector */}
      <div className="tool-group">
        <select
          className="select-dropdown"
          onChange={(e) => {
            handleTemplateLoad(e.target.value);
            e.target.value = '';
          }}
          defaultValue=""
        >
          <option value="" disabled>
            📂 Load Template...
          </option>
          <option value="studio">Modern Studio Apartment</option>
          <option value="one_bedroom">1-Bedroom Flat</option>
          <option value="clear">Clear Canvas</option>
        </select>
      </div>

      {/* Export / Import */}
      <div className="tool-group-right">
        <button
          className="tool-btn"
          onClick={() => {
            const svg = document.getElementById('floorplan-svg') as unknown as SVGSVGElement;
            if (svg) exportSVGToPNG(svg, 'floorgan-floorplan.png');
          }}
          title="Export high-resolution PNG image"
        >
          <Download size={16} />
          <span>Export Image</span>
        </button>

        <button
          className="tool-btn-icon"
          onClick={() => exportToJSON(state, 'floorgan-floorplan.json')}
          title="Save Project (JSON)"
        >
          <FileSpreadsheet size={18} />
        </button>

        <label className="tool-btn-icon cursor-pointer" title="Load Project (JSON)">
          <Upload size={18} />
          <input
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleImportJSON}
          />
        </label>

        <button
          className="tool-btn-icon danger"
          onClick={() => handleTemplateLoad('clear')}
          title="Clear Floorplan"
        >
          <Trash2 size={18} />
        </button>
      </div>
    </header>
  );
};
