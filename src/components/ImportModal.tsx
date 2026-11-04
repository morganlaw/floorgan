import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Upload,
  Globe,
  Check,
  Eye,
  Layers,
  AlertCircle,
  Loader2,
  FileImage,
} from 'lucide-react';
import { FloorplanState } from '../types';
import {
  MAX_PROC_DIM,
  DEFAULT_PARSE_OPTIONS,
  ParseOptions,
  ParseResult,
  RawDimensionCandidate,
  RawRoomNameCandidate,
  OcrTextBoxPx,
  SegmentationMasks,
  parseFloorplanImage,
  extractOcrDimensionsFromImage,
  fetchFloorplanFromUrl,
  fetchImageUrlAsDataUrl,
  createSampleBlueprintDataUrl,
  prewarmOcrWorker,
  terminateOcrWorker,
  isDarkBlueprintImage,
} from '../utils/floorplanParser.ts';
import {
  segmentFloorplanMlBrowser,
  prewarmBrowserMl,
  scheduleImportRelease,
  releaseBrowserMlSession,
  withTimeout,
  type MlBackend,
} from '../utils/mlSegmenter.ts';

const OCR_TIMEOUT_MS = 15_000;

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  state: FloorplanState;
  onImport: (newState: FloorplanState) => void;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  onClose,
  state,
  onImport,
}) => {
  const [activeTab, setActiveTab] = useState<'upload' | 'url'>('upload');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [loadedImageEl, setLoadedImageEl] = useState<HTMLImageElement | null>(null);

  const [urlInput, setUrlInput] = useState('');
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlCandidates, setUrlCandidates] = useState<{ url: string; label: string }[]>([]);

  const [invertColors, setInvertColors] = useState<boolean>(false);
  const options = React.useMemo<ParseOptions>(
    () => ({ ...DEFAULT_PARSE_OPTIONS, invert: invertColors }),
    [invertColors]
  );
  const [ocrCandidates, setOcrCandidates] = useState<RawDimensionCandidate[]>([]);
  const [roomCandidates, setRoomCandidates] = useState<RawRoomNameCandidate[]>([]);
  const [ocrTextBoxes, setOcrTextBoxes] = useState<OcrTextBoxPx[]>([]);
  const [isScanningOcr, setIsScanningOcr] = useState<boolean>(false);
  const [useOcrScale, setUseOcrScale] = useState<boolean>(true);
  const [parserEngine, setParserEngine] = useState<'ml' | 'otsu'>('ml');
  const [mlMasks, setMlMasks] = useState<SegmentationMasks | null>(null);
  const [isRunningMl, setIsRunningMl] = useState<boolean>(false);
  const [mlError, setMlError] = useState<string | null>(null);
  const [mlBackend, setMlBackend] = useState<MlBackend | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [previewMode, setPreviewMode] = useState<'overlay' | 'mask'>('overlay');
  const [includeUnderlay, setIncludeUnderlay] = useState<boolean>(true);
  const [keepExistingFurniture, setKeepExistingFurniture] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mlRunningRef = useRef<boolean>(false);
  const mlRunIdRef = useRef<number>(0);
  const loadedImageElRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    loadedImageElRef.current = loadedImageEl;
  }, [loadedImageEl]);

  const handleFileSelect = (file: File) => {
    setUrlError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageDataUrl(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

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

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    prewarmBrowserMl()
      .then((backend) => setMlBackend(backend))
      .catch(() => {});
    prewarmOcrWorker().catch(() => {});
    return () => {
      // Phones free the model's ~200 MB right away so the tab isn't killed.
      if (window.matchMedia('(pointer: coarse)').matches) {
        releaseBrowserMlSession().catch(() => {});
        terminateOcrWorker().catch(() => {});
      } else {
        scheduleImportRelease();
      }
    };
  }, [isOpen]);

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
      try {
        const c = document.createElement('canvas');
        const sw = Math.min(128, img.naturalWidth || img.width || 128);
        const sh = Math.min(128, img.naturalHeight || img.height || 128);
        c.width = sw;
        c.height = sh;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, sw, sh);
          const data = ctx.getImageData(0, 0, sw, sh);
          if (isDarkBlueprintImage(data.data, sw, sh)) {
            setInvertColors(true);
          } else {
            setInvertColors(false);
          }
        }
      } catch (err) {
        console.warn('Blueprint auto-detect warning:', err);
      }
      setLoadedImageEl(img);
    };
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  useEffect(() => {
    if (!loadedImageEl) return;
    let cancelled = false;
    setIsScanningOcr(true);

    withTimeout(extractOcrDimensionsFromImage(loadedImageEl, options.invert), OCR_TIMEOUT_MS, 'OCR')
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

  useEffect(() => {
    setMlMasks(null);
    setMlError(null);
    mlRunningRef.current = false;
    mlRunIdRef.current += 1;
  }, [loadedImageEl, options.invert]);

  useEffect(() => {
    if (!loadedImageEl || parserEngine !== 'ml') {
      setIsRunningMl(false);
      return;
    }

    if (mlMasks || mlError) {
      setIsRunningMl(false);
      return;
    }

    if (mlRunningRef.current) {
      setIsRunningMl(true);
      return;
    }

    mlRunningRef.current = true;
    setIsRunningMl(true);
    const runId = mlRunIdRef.current;

    const naturalW = loadedImageEl.naturalWidth || loadedImageEl.width || 600;
    const naturalH = loadedImageEl.naturalHeight || loadedImageEl.height || 450;
    const downscale = Math.min(1, MAX_PROC_DIM / Math.max(naturalW, naturalH));
    const w = Math.max(64, Math.round(naturalW * downscale));
    const h = Math.max(64, Math.round(naturalH * downscale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(loadedImageEl, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);

    segmentFloorplanMlBrowser(imgData.data, w, h, options, ocrTextBoxes)
      .then((masks) => {
        if (mlRunIdRef.current === runId) {
          setMlMasks(masks);
        }
      })
      .catch((err) => {
        console.warn('Segmentation fallback to Otsu:', err);
        if (mlRunIdRef.current === runId) {
          setMlError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (mlRunIdRef.current === runId) {
          mlRunningRef.current = false;
          setIsRunningMl(false);
        }
      });
  }, [loadedImageEl, parserEngine, mlMasks, mlError, options.invert]);

  useEffect(() => {
    if (!loadedImageEl) return;
    // On the GPU the ML masks arrive within a second; skip the interim non-ML parse.
    if (parserEngine === 'ml' && !mlMasks && !mlError && mlBackend === 'webgpu') {
      setParseResult(null);
      return;
    }
    const res = parseFloorplanImage(
      loadedImageEl,
      options,
      ocrCandidates,
      useOcrScale,
      roomCandidates,
      ocrTextBoxes,
      parserEngine === 'ml' && mlMasks ? mlMasks : undefined
    );
    setParseResult(res);
  }, [loadedImageEl, options, ocrCandidates, useOcrScale, roomCandidates, ocrTextBoxes, parserEngine, mlMasks, mlError, mlBackend]);

  if (!isOpen) return null;

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
    } catch (err: unknown) {
      setUrlError(err instanceof Error ? err.message : 'Failed to fetch floorplan from URL.');
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
    } catch (err: unknown) {
      setUrlError(err instanceof Error ? err.message : 'Could not load selected image from page.');
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

  const mlBusy = parserEngine === 'ml' && isRunningMl;
  const isBusy = mlBusy || isScanningOcr;
  const busyLabel = mlBusy
    ? mlBackend
      ? 'Running model…'
      : 'Loading model…'
    : isScanningOcr
      ? 'Reading dimensions…'
      : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card import-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
      >
        <div className="modal-header">
          <div>
            <h3 className="modal-title" id="import-modal-title">Generate Floorplan from Image</h3>
            <p className="import-subtitle">
              Upload a blueprint or floorplan image to automatically generate interactive walls, doors, and windows.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="import-modal-body">
          <div className="import-controls-col">
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label="Upload floorplan image"
                >
                  <FileImage size={24} className="text-blue-600" />
                  <span className="dropzone-title">
                    Click to upload or drag and drop
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

            {imageDataUrl && (
              <div className="import-config-card">
                <div className="field-group mb-2">
                  <div className="flex justify-between items-center mb-1">
                    <label className="field-label">Parser Engine</label>
                    {isRunningMl && parserEngine === 'ml' && (
                      <span className="text-xs text-blue-600 flex items-center gap-1">
                        <Loader2 size={12} className="spin" />
                        {mlBackend ? 'Segmenting floorplan' : 'Loading model'}
                        {mlBackend === 'webgpu' ? ' (GPU)' : mlBackend === 'wasm' ? ' (CPU, slower)' : ''}...
                      </span>
                    )}
                  </div>
                  <div className="import-tabs">
                    <button
                      type="button"
                      className={`import-tab ${parserEngine === 'ml' ? 'active' : ''}`}
                      onClick={() => setParserEngine('ml')}
                    >
                      <span>Neural Model (ConvNeXt)</span>
                    </button>
                    <button
                      type="button"
                      className={`import-tab ${parserEngine === 'otsu' ? 'active' : ''}`}
                      onClick={() => setParserEngine('otsu')}
                    >
                      <span>Classic CV (Otsu)</span>
                    </button>
                  </div>
                </div>

                <label className="checkbox-row" style={{ marginTop: '0.25rem', marginBottom: '0.25rem' }}>
                  <input
                    type="checkbox"
                    checked={invertColors}
                    onChange={(e) => setInvertColors(e.target.checked)}
                  />
                  <span>Invert blueprint colors (light lines on dark background)</span>
                </label>

                {parserEngine === 'ml' && mlError && (
                  <div className="import-alert" role="status">
                    <AlertCircle size={15} />
                    <span>
                      Neural model unavailable ({mlError}). Showing the Classic CV result instead.
                    </span>
                  </div>
                )}

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
              </div>
            )}
          </div>

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
                  disabled={!parseResult || isBusy}
                  onClick={handleApplyImport}
                >
                  {isBusy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                  <span>{busyLabel ?? 'Generate Floorplan'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
