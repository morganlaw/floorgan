import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Upload,
  Globe,
  Sliders,
  Check,
  Eye,
  Layers,
  AlertCircle,
  Loader2,
  FileImage,
} from 'lucide-react';
import { FloorplanState } from '../types';
import {
  ParseOptions,
  DEFAULT_PARSE_OPTIONS,
  ParseResult,
  RawDimensionCandidate,
  RawRoomNameCandidate,
  OcrTextBoxPx,
  parseFloorplanImage,
  extractOcrDimensionsFromImage,
  fetchFloorplanFromUrl,
  fetchImageUrlAsDataUrl,
  createSampleBlueprintDataUrl,
} from '../utils/floorplanParser';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  state: FloorplanState;
  onImport: (newState: FloorplanState) => void;
}

export const ImportModal: React.FC<Props> = ({ isOpen, onClose, state, onImport }) => {
  const [activeTab, setActiveTab] = useState<'upload' | 'url'>('upload');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [loadedImageEl, setLoadedImageEl] = useState<HTMLImageElement | null>(null);

  // URL state
  const [urlInput, setUrlInput] = useState('');
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlCandidates, setUrlCandidates] = useState<{ url: string; label: string }[]>([]);

  // Deterministic CV + OCR Parser options
  const [options, setOptions] = useState<ParseOptions>(DEFAULT_PARSE_OPTIONS);
  const [ocrCandidates, setOcrCandidates] = useState<RawDimensionCandidate[]>([]);
  const [roomCandidates, setRoomCandidates] = useState<RawRoomNameCandidate[]>([]);
  const [ocrTextBoxes, setOcrTextBoxes] = useState<OcrTextBoxPx[]>([]);
  const [isScanningOcr, setIsScanningOcr] = useState<boolean>(false);
  const [useOcrScale, setUseOcrScale] = useState<boolean>(true);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [previewMode, setPreviewMode] = useState<'overlay' | 'mask'>('overlay');
  const [includeUnderlay, setIncludeUnderlay] = useState<boolean>(true);
  const [keepExistingFurniture, setKeepExistingFurniture] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Listen for clipboard image paste (Ctrl+V / Cmd+V) when modal is open
  useEffect(() => {
    if (!isOpen) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            handleFileSelect(file);
            break;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isOpen]);

  // Decode HTMLImageElement whenever imageDataUrl changes
  useEffect(() => {
    if (!imageDataUrl) {
      setLoadedImageEl(null);
      setParseResult(null);
      setOcrCandidates([]);
      setRoomCandidates([]);
      setOcrTextBoxes([]);
      return;
    }
    const img = new Image();
    img.onload = () => {
      setLoadedImageEl(img);
    };
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  // Run deterministic client-side OCR to detect printed room names & dimensions
  useEffect(() => {
    if (!loadedImageEl) return;
    let cancelled = false;
    setIsScanningOcr(true);

    extractOcrDimensionsFromImage(loadedImageEl, options.invert)
      .then((ocrRes) => {
        if (!cancelled) {
          setOcrCandidates(ocrRes.dimensions);
          setRoomCandidates(ocrRes.roomNames);
          setOcrTextBoxes(ocrRes.textBoxes);
          if (ocrRes.dimensions.length > 0) {
            setUseOcrScale(true);
          }
        }
      })
      .catch((err) => {
        console.warn('OCR dimension scan warning:', err);
      })
      .finally(() => {
        if (!cancelled) setIsScanningOcr(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadedImageEl, options.invert]);

  // Re-run deterministic CV pipeline whenever image, options, or OCR candidates change
  useEffect(() => {
    if (!loadedImageEl) return;
    const res = parseFloorplanImage(
      loadedImageEl,
      options,
      ocrCandidates,
      useOcrScale,
      roomCandidates,
      ocrTextBoxes
    );
    setParseResult(res);
  }, [loadedImageEl, options, ocrCandidates, useOcrScale, roomCandidates, ocrTextBoxes]);

  if (!isOpen) return null;

  const handleFileSelect = (file: File) => {
    setUrlError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageDataUrl(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleFetchUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    setIsLoadingUrl(true);
    setUrlError(null);
    setUrlCandidates([]);

    try {
      const result = await fetchFloorplanFromUrl(urlInput);
      if (result.candidates.length > 0) {
        setUrlCandidates(result.candidates);
      }
      if (result.primaryDataUrl) {
        setImageDataUrl(result.primaryDataUrl);
      } else if (result.candidates.length > 0) {
        const dataUrl = await fetchImageUrlAsDataUrl(result.candidates[0].url);
        setImageDataUrl(dataUrl);
      }
    } catch (err: any) {
      setUrlError(err.message || 'Failed to fetch floorplan from URL.');
    } finally {
      setIsLoadingUrl(false);
    }
  };

  const handleSelectCandidate = async (candidateUrl: string) => {
    setIsLoadingUrl(true);
    setUrlError(null);
    try {
      const dataUrl = await fetchImageUrlAsDataUrl(candidateUrl);
      setImageDataUrl(dataUrl);
    } catch (err: any) {
      setUrlError(err.message || 'Could not load selected image from page.');
    } finally {
      setIsLoadingUrl(false);
    }
  };

  const handleLoadSample = () => {
    setUrlError(null);
    const sampleUrl = createSampleBlueprintDataUrl();
    setImageDataUrl(sampleUrl);
  };

  const handleApplyImport = () => {
    if (!parseResult || !imageDataUrl) return;

    const newState: FloorplanState = {
      ...state,
      unit: parseResult.detectedUnit || state.unit,
      walls: parseResult.walls,
      doors: parseResult.doors,
      windows: parseResult.windows,
      furniture: keepExistingFurniture ? state.furniture : [],
      textBoxes: keepExistingFurniture ? state.textBoxes : [],
      measurements: [],
      roomLabels: [],
      background: includeUnderlay
        ? {
            dataUrl: imageDataUrl,
            x: parseResult.originOffset.x,
            y: parseResult.originOffset.y,
            width: parseResult.boundsCm.width,
            height: parseResult.boundsCm.height,
            opacity: 0.38,
            visible: true,
          }
        : null,
    };

    onImport(newState);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card import-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <div>
            <h3 className="modal-title">Generate Floorplan from Image</h3>
            <p className="import-subtitle">
              Upload a blueprint or floorplan image to automatically generate interactive walls, doors, and windows.
            </p>
          </div>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="import-modal-body">
          {/* Left Column: Source Selection & Vectorization Controls */}
          <div className="import-controls-col">
            {/* Source Tabs */}
            <div className="import-tabs">
              <button
                className={`import-tab ${activeTab === 'upload' ? 'active' : ''}`}
                onClick={() => setActiveTab('upload')}
              >
                <Upload size={14} />
                <span>Upload / Paste Image</span>
              </button>
              <button
                className={`import-tab ${activeTab === 'url' ? 'active' : ''}`}
                onClick={() => setActiveTab('url')}
              >
                <Globe size={14} />
                <span>Website Link (URL)</span>
              </button>
            </div>

            {/* Tab Content: Upload */}
            {activeTab === 'upload' && (
              <div className="import-source-box">
                <div
                  className="dropzone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0];
                    if (file) handleFileSelect(file);
                  }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileImage size={24} className="text-blue-600" />
                  <span className="dropzone-title">
                    Click to upload, drag & drop, or press <kbd>Ctrl+V</kbd>
                  </span>
                  <span className="dropzone-sub">PNG, JPG, WEBP, or SVG floorplan</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFileSelect(file);
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="btn-secondary w-full mt-2"
                  onClick={handleLoadSample}
                >
                  <Layers size={14} />
                  <span>Load Sample Blueprint Image to Test</span>
                </button>
              </div>
            )}

            {/* Tab Content: Website Link */}
            {activeTab === 'url' && (
              <div className="import-source-box">
                <form onSubmit={handleFetchUrl} className="url-form">
                  <input
                    type="text"
                    placeholder="https://example.com/floorplan.png or listing page URL..."
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    className="field-input flex-1"
                  />
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={isLoadingUrl || !urlInput.trim()}
                  >
                    {isLoadingUrl ? <Loader2 size={14} className="spin" /> : 'Fetch'}
                  </button>
                </form>
                <span className="url-hint">
                  Supports direct image links (.png, .jpg, .webp) or listing webpages with embedded floorplans.
                </span>

                {urlCandidates.length > 1 && (
                  <div className="candidates-list">
                    <span className="field-label">Extracted Images on Page:</span>
                    <div className="candidates-chips">
                      {urlCandidates.map((cand, idx) => (
                        <button
                          key={idx}
                          type="button"
                          className="chip-btn"
                          onClick={() => handleSelectCandidate(cand.url)}
                          title={cand.url}
                        >
                          #{idx + 1} {cand.label.slice(0, 26)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {urlError && (
              <div className="import-alert">
                <AlertCircle size={15} />
                <span>{urlError}</span>
              </div>
            )}

            {/* Image Status & Primary Settings */}
            {imageDataUrl && (
              <div className="import-config-card">
                {isScanningOcr && (
                  <div className="text-xs text-slate-500 flex items-center gap-1.5 py-1">
                    <Loader2 size={13} className="spin text-blue-600" />
                    <span>Detecting blueprint dimensions...</span>
                  </div>
                )}

                {!isScanningOcr && parseResult?.autoCalibratedWidthMeters && (
                  <label className="checkbox-row import-scale-row">
                    <input
                      type="checkbox"
                      checked={useOcrScale}
                      onChange={(e) => setUseOcrScale(e.target.checked)}
                    />
                    <span>
                      Use detected scale (width: <strong>{parseResult.autoCalibratedWidthMeters.toFixed(1)}m</strong>)
                    </span>
                  </label>
                )}

                <div className="import-toggles-clean">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={includeUnderlay}
                      onChange={(e) => setIncludeUnderlay(e.target.checked)}
                    />
                    <span>Keep image as background reference underlay</span>
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={keepExistingFurniture}
                      onChange={(e) => setKeepExistingFurniture(e.target.checked)}
                    />
                    <span>Keep current furniture on canvas</span>
                  </label>
                </div>

                {/* Collapsible fine-tuning settings */}
                <details className="parser-settings-disclosure">
                  <summary className="parser-disclosure-header">
                    <Sliders size={13} />
                    <span>Fine-tune detection settings</span>
                  </summary>

                  <div className="parser-disclosure-body">
                    <div className="field-group">
                      <div className="flex justify-between items-center">
                        <label className="field-label">Wall Darkness Sensitivity</label>
                        <label className="checkbox-inline">
                          <input
                            type="checkbox"
                            checked={options.threshold === 0}
                            onChange={(e) =>
                              setOptions((prev) => ({
                                ...prev,
                                threshold: e.target.checked
                                  ? 0
                                  : parseResult?.computedThreshold || 160,
                              }))
                            }
                          />
                          <span>Auto</span>
                        </label>
                      </div>
                      {options.threshold > 0 && (
                        <input
                          type="range"
                          min="40"
                          max="240"
                          value={options.threshold}
                          onChange={(e) =>
                            setOptions((prev) => ({ ...prev, threshold: Number(e.target.value) }))
                          }
                          className="slider-range"
                        />
                      )}
                    </div>

                    <div className="field-group">
                      <div className="flex justify-between items-center">
                        <label className="field-label">Noise & Text Filter</label>
                        <span className="text-xs font-mono font-bold text-blue-600">
                          {options.minWallThicknessPx} px
                        </span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="9"
                        step="1"
                        value={options.minWallThicknessPx}
                        onChange={(e) =>
                          setOptions((prev) => ({
                            ...prev,
                            minWallThicknessPx: Number(e.target.value),
                          }))
                        }
                        className="slider-range"
                      />
                    </div>

                    <div className="field-group">
                      <div className="flex justify-between items-center">
                        <label className="field-label">Min Wall Length</label>
                        <span className="text-xs font-mono font-bold text-blue-600">
                          {options.minWallLengthCm} cm
                        </span>
                      </div>
                      <input
                        type="range"
                        min="30"
                        max="160"
                        step="10"
                        value={options.minWallLengthCm}
                        onChange={(e) =>
                          setOptions((prev) => ({
                            ...prev,
                            minWallLengthCm: Number(e.target.value),
                          }))
                        }
                        className="slider-range"
                      />
                    </div>

                    <div className="parser-toggles">
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={options.detectOpenings}
                          onChange={(e) =>
                            setOptions((prev) => ({ ...prev, detectOpenings: e.target.checked }))
                          }
                        />
                        <span>Auto-detect doors & windows</span>
                      </label>

                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={options.closeHollowWalls}
                          onChange={(e) =>
                            setOptions((prev) => ({
                              ...prev,
                              closeHollowWalls: e.target.checked,
                            }))
                          }
                        />
                        <span>Fill double-line walls</span>
                      </label>

                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={options.invert}
                          onChange={(e) =>
                            setOptions((prev) => ({ ...prev, invert: e.target.checked }))
                          }
                        />
                        <span>Invert colors (for dark blueprints)</span>
                      </label>
                    </div>
                  </div>
                </details>

                <button
                  type="button"
                  className="btn-primary w-full mt-3"
                  disabled={!parseResult}
                  onClick={handleApplyImport}
                >
                  <Check size={16} />
                  <span>Generate Floorplan</span>
                </button>
              </div>
            )}
          </div>

          {/* Right Column: Interactive Live Vector Preview */}
          <div className="import-preview-col">
            <div className="preview-toolbar">
              <div className="segmented-control">
                <button
                  type="button"
                  className={`segment-btn ${previewMode === 'overlay' ? 'active' : ''}`}
                  onClick={() => setPreviewMode('overlay')}
                >
                  <Eye size={12} style={{ display: 'inline', marginRight: 4 }} />
                  Vector Overlay
                </button>
                <button
                  type="button"
                  className={`segment-btn ${previewMode === 'mask' ? 'active' : ''}`}
                  onClick={() => setPreviewMode('mask')}
                >
                  <Layers size={12} style={{ display: 'inline', marginRight: 4 }} />
                  Isolated Wall Mask
                </button>
              </div>

              {parseResult && (
                <div className="preview-badges">
                  <span className="preview-badge">{parseResult.walls.length} Walls</span>
                  <span className="preview-badge">{parseResult.doors.length} Doors</span>
                  <span className="preview-badge">{parseResult.windows.length} Windows</span>
                </div>
              )}
            </div>

            <div className="preview-stage">
              {!imageDataUrl || !parseResult ? (
                <div className="preview-empty">
                  <FileImage size={36} className="text-slate-300" />
                  <p>Upload a floorplan image, paste a link, or click "Load Sample Blueprint"</p>
                </div>
              ) : (
                <svg
                  className="preview-svg"
                  viewBox={`${parseResult.originOffset.x - 40} ${
                    parseResult.originOffset.y - 40
                  } ${parseResult.boundsCm.width + 80} ${parseResult.boundsCm.height + 80}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {/* Base raster image or morphological mask */}
                  <image
                    href={
                      previewMode === 'mask' ? parseResult.maskPreviewDataUrl : imageDataUrl
                    }
                    x={parseResult.originOffset.x}
                    y={parseResult.originOffset.y}
                    width={parseResult.boundsCm.width}
                    height={parseResult.boundsCm.height}
                    opacity={previewMode === 'overlay' ? 0.35 : 0.9}
                    preserveAspectRatio="none"
                  />

                  {/* Extracted Vector Walls */}
                  {parseResult.walls.map((w) => (
                    <g key={w.id}>
                      <line
                        x1={w.start.x}
                        y1={w.start.y}
                        x2={w.end.x}
                        y2={w.end.y}
                        stroke="#2563eb"
                        strokeWidth={w.thickness}
                        strokeLinecap="square"
                        opacity={0.85}
                      />
                      <circle cx={w.start.x} cy={w.start.y} r={5} fill="#1d4ed8" />
                      <circle cx={w.end.x} cy={w.end.y} r={5} fill="#1d4ed8" />
                    </g>
                  ))}

                  {/* Extracted Doors */}
                  {parseResult.doors.map((d) => (
                    <g
                      key={d.id}
                      transform={`translate(${d.x}, ${d.y}) rotate(${d.rotation})`}
                    >
                      <rect
                        x={-d.width / 2}
                        y={-12}
                        width={d.width}
                        height={24}
                        fill="#fef3c7"
                        stroke="#d97706"
                        strokeWidth={3}
                      />
                    </g>
                  ))}

                  {/* Extracted Windows */}
                  {parseResult.windows.map((win) => (
                    <g
                      key={win.id}
                      transform={`translate(${win.x}, ${win.y}) rotate(${win.rotation})`}
                    >
                      <rect
                        x={-win.width / 2}
                        y={-10}
                        width={win.width}
                        height={20}
                        fill="#e0f2fe"
                        stroke="#0284c7"
                        strokeWidth={3}
                      />
                    </g>
                  ))}
                </svg>
              )}
            </div>

            <div className="preview-footer">
              <span className="text-xs text-slate-500">
                Tip: Generated walls, doors, and windows can be resized, moved, or deleted on the canvas.
              </span>
              <div className="flex gap-2">
                <button type="button" className="btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!parseResult}
                  onClick={handleApplyImport}
                >
                  <Check size={15} />
                  <span>Generate Floorplan</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
