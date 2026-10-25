import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { FloorplanState, SelectedElementType, ToolMode } from './types';
import { TEMPLATES } from './templates';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { FloorplanCanvas } from './components/FloorplanCanvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { ImportModal } from './components/ImportModal';
import { useFloorplanHistory } from './utils/useHistory';
import './App.css';

const STORAGE_KEY = 'floorgan_floorplan_v1';

function getInitialFloorplan(): FloorplanState {
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
}

export const App: React.FC = () => {
  const {
    state,
    setState,
    undo,
    redo,
    canUndo,
    canRedo,
    startInteraction,
    endInteraction,
  } = useFloorplanHistory(getInitialFloorplan());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, background: null }));
      } catch (innerErr) {
        console.warn('Could not save floorplan to localStorage', innerErr);
      }
    }
  }, [state]);

  const [tool, setTool] = useState<ToolMode>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState<SelectedElementType>(null);

  const [zoom, setZoom] = useState<number>(0.9);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 140, y: 100 });
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [showImportModal, setShowImportModal] = useState<boolean>(false);

  useEffect(() => {
    if (!selectedId && selectedIds.length === 0) return;
    const allExistingIds = new Set([
      ...state.furniture.map((f) => f.id),
      ...state.walls.map((w) => w.id),
      ...state.doors.map((d) => d.id),
      ...state.windows.map((win) => win.id),
      ...state.measurements.map((m) => m.id),
      ...(state.textBoxes || []).map((t) => t.id),
    ]);

    const nextSelectedIds = selectedIds.filter((id) => allExistingIds.has(id));
    if (nextSelectedIds.length !== selectedIds.length) {
      setSelectedIds(nextSelectedIds);
    }

    if (selectedId && !allExistingIds.has(selectedId)) {
      if (nextSelectedIds.length > 0) {
        setSelectedId(nextSelectedIds[0]);
        setSelectedType(nextSelectedIds.length > 1 ? 'multiple' : null);
      } else {
        setSelectedId(null);
        setSelectedType(null);
      }
    }
  }, [state, selectedId, selectedIds]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

      if (cmdOrCtrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (cmdOrCtrl && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  return (
    <div className="app-container">
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
        onOpenShortcuts={() => setShowHelp(true)}
        undo={undo}
        redo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
      />

      <div className="workspace">
        <Sidebar
          state={state}
          setState={setState}
          setSelectedId={setSelectedId}
          setSelectedType={setSelectedType}
        />

        <FloorplanCanvas
          state={state}
          setState={setState}
          tool={tool}
          setTool={setTool}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          selectedType={selectedType}
          setSelectedType={setSelectedType}
          zoom={zoom}
          setZoom={setZoom}
          pan={pan}
          setPan={setPan}
          onStartInteraction={startInteraction}
          onEndInteraction={endInteraction}
        />

        <PropertiesPanel
          state={state}
          setState={setState}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          selectedType={selectedType}
          setSelectedType={setSelectedType}
          setTool={setTool}
        />
      </div>

      <ImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        state={state}
        onImport={(newState: FloorplanState) => {
          setState(newState);
          setSelectedId(null);
          setSelectedIds([]);
          setSelectedType(null);
          setZoom(0.75);
          setPan({ x: 120, y: 80 });
        }}
      />

      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Floorgan Guide</h3>
              <button className="modal-close" onClick={() => setShowHelp(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <div className="shortcuts-grid">
                <div className="shortcut-item">
                  <kbd>⌘Z</kbd> / <kbd>Ctrl+Z</kbd>
                  <span>Undo last action</span>
                </div>
                <div className="shortcut-item">
                  <kbd>⌘⇧Z</kbd> / <kbd>Ctrl+Y</kbd>
                  <span>Redo action</span>
                </div>
                <div className="shortcut-item">
                  <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd>
                  <span>Pan canvas view (or Arrow keys)</span>
                </div>
                <div className="shortcut-item">
                  <kbd>1</kbd> .. <kbd>7</kbd>
                  <span>Select Tool (1: Select, 2: Wall, 3: Door, 4: Window, 5: Text, 6: Measure, 7: Pan)</span>
                </div>
                <div className="shortcut-item">
                  <kbd>V</kbd>
                  <span>Select & Move Tool</span>
                </div>
                <div className="shortcut-item">
                  <kbd>T</kbd>
                  <span>Custom Text Box Tool</span>
                </div>
                <div className="shortcut-item">
                  <kbd>M</kbd>
                  <span>Measuring Tape Tool</span>
                </div>
                <div className="shortcut-item">
                  <kbd>H</kbd>
                  <span>Pan Tool</span>
                </div>
                <div className="shortcut-item">
                  <kbd>Shift</kbd> + Drag / Click
                  <span>Multi-select elements, or snap walls/rotation to 45°/90°</span>
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
                  <span>Delete selected wall, furniture, door, window, or measurement</span>
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
