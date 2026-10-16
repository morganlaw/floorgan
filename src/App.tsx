import React, { useState, useEffect } from 'react';
import { FloorplanState, ToolMode } from './types';
import { TEMPLATES } from './templates';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { FloorplanCanvas } from './components/FloorplanCanvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { ImportModal } from './components/ImportModal';
import { HelpCircle, X } from 'lucide-react';
import './App.css';

const STORAGE_KEY = 'floorgan_floorplan_v1';

export const App: React.FC = () => {
  // Load saved floorplan from browser localStorage or default to studio template
  const [state, setState] = useState<FloorplanState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('mapgan_floorplan_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.walls)) {
          return {
            ...parsed,
            measurements: parsed.measurements || [],
          };
        }
      }
    } catch (e) {
      console.warn('Could not load saved floorplan from localStorage', e);
    }
    return TEMPLATES.studio.state;
  });

  // Automatically persist state changes to browser localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Fallback if background dataUrl exceeds localStorage quota
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, background: null }));
      } catch (innerErr) {
        console.warn('Could not save floorplan to localStorage', innerErr);
      }
    }
  }, [state]);

  const [tool, setTool] = useState<ToolMode>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<
    'furniture' | 'wall' | 'door' | 'window' | 'measurement' | null
  >(null);

  // View state
  const [zoom, setZoom] = useState<number>(0.9);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 140, y: 100 });
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [showImportModal, setShowImportModal] = useState<boolean>(false);

  return (
    <div className="app-container">
      {/* Top Application Toolbar */}
      <Toolbar
        tool={tool}
        setTool={setTool}
        state={state}
        setState={setState}
        zoom={zoom}
        setZoom={setZoom}
        setPan={setPan}
        setSelectedId={setSelectedId}
        setSelectedType={setSelectedType}
        onOpenImportModal={() => setShowImportModal(true)}
      />

      {/* Main Workspace */}
      <div className="workspace">
        {/* Left Furniture & Fixtures Catalog */}
        <Sidebar
          state={state}
          setState={setState}
          setSelectedId={setSelectedId}
          setSelectedType={setSelectedType}
        />

        {/* Center Canvas */}
        <FloorplanCanvas
          state={state}
          setState={setState}
          tool={tool}
          setTool={setTool}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          selectedType={selectedType}
          setSelectedType={setSelectedType}
          zoom={zoom}
          setZoom={setZoom}
          pan={pan}
          setPan={setPan}
        />

        {/* Right Properties Inspector */}
        <PropertiesPanel
          state={state}
          setState={setState}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          selectedType={selectedType}
          setSelectedType={setSelectedType}
          setTool={setTool}
        />
      </div>

      {/* Floorplan Image & URL Importer Modal */}
      <ImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        state={state}
        onImport={(newState: FloorplanState) => {
          setState(newState);
          setSelectedId(null);
          setSelectedType(null);
          setZoom(0.75);
          setPan({ x: 120, y: 80 });
        }}
      />

      {/* Floating Keyboard Shortcuts Button */}
      <button
        className="floating-help-btn"
        onClick={() => setShowHelp(true)}
        title="Keyboard shortcuts & guide"
      >
        <HelpCircle size={18} />
        <span>Shortcuts</span>
      </button>

      {/* Shortcuts & Guide Modal */}
      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">FloorGAN Planner Guide</h3>
              <button className="modal-close" onClick={() => setShowHelp(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <div className="shortcuts-grid">
                <div className="shortcut-item">
                  <kbd>V</kbd>
                  <span>Select & Move Tool</span>
                </div>
                <div className="shortcut-item">
                  <kbd>W</kbd>
                  <span>Draw Wall Mode (Click to start, click to end)</span>
                </div>
                <div className="shortcut-item">
                  <kbd>D</kbd>
                  <span>Place Door on Wall</span>
                </div>
                <div className="shortcut-item">
                  <kbd>M</kbd>
                  <span>Measuring Tape Tool</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Shift</kbd>
                  <span>Snap walls & rotation to 45° / 90° angles</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Space</kbd> + Drag
                  <span>Pan canvas workspace</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Scroll</kbd>
                  <span>Zoom in & out toward cursor</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Delete</kbd> / <kbd>⌫</kbd>
                  <span>Delete selected wall, furniture, door, or window</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Esc</kbd>
                  <span>Cancel active drawing or measuring</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
