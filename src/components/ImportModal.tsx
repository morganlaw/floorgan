import React, { useState, useEffect, useRef } from 'react';
import { X, Globe, Check, AlertCircle, Loader2, FileImage } from 'lucide-react';
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
  extractOcrDimensionsFromImage,
  fetchFloorplanFromUrl,
  fetchImageUrlAsBlob,
  createSampleBlueprintBlob,
  prewarmOcrWorker,
  terminateOcrWorker,
  isDarkBlueprintImage,
} from '../utils/floorplanParser.ts';
import {
  segmentFloorplanMlBrowser,
  prewarmBrowserMl,
  scheduleImportRelease,
  releaseBrowserMlSession,
  setImportDialogOpen,
  withTimeout,
  type MlBackend,
} from '../utils/mlSegmenter.ts';
import { parseFloorplanInWorker } from '../utils/parseClient.ts';
import { storeUnderlayImage } from '../utils/underlayStore.ts';

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
  // The image is kept as binary data; the preview gets a short-lived object URL for it.
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [loadedImageEl, setLoadedImageEl] = useState<HTMLImageElement | null>(null);
  // The image downscaled to processing size, decoded once and shared by the model and the parser.
  const [imagePixels, setImagePixels] = useState<{
    rgba: Uint8ClampedArray;
    w: number;
    h: number;
  } | null>(null);

  const [urlInput, setUrlInput] = useState('');
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlCandidates, setUrlCandidates] = useState<{ url: string; label: string }[]>([]);

  // Set automatically from the image (dark blueprints); there is no manual toggle.
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
  const [mlMasks, setMlMasks] = useState<SegmentationMasks | null>(null);
  const [isRunningMl, setIsRunningMl] = useState<boolean>(false);
  const [mlError, setMlError] = useState<string | null>(null);
  const [mlBackend, setMlBackend] = useState<MlBackend | null>(null);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [parseError, setParseError] = useState<string | null>(null);
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
    setUrlCandidates([]);
    setImageBlob(file);
  };

  useEffect(() => {
    if (!imageBlob) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(imageBlob);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageBlob]);

  const fetchFromUrl = async (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return;
    setIsLoadingUrl(true);
    setUrlError(null);
    setUrlCandidates([]);

    try {
      const result = await fetchFloorplanFromUrl(url);
      if (result.candidates.length > 0) {
        setUrlCandidates(result.candidates);
      }
      if (result.primaryBlob) {
        setImageBlob(result.primaryBlob);
      } else if (result.candidates.length > 0) {
        setImageBlob(await fetchImageUrlAsBlob(result.candidates[0].url));
      }
    } catch (err: unknown) {
      setUrlError(err instanceof Error ? err.message : 'Failed to fetch floorplan from URL.');
    } finally {
      setIsLoadingUrl(false);
    }
  };

  // The paste listener is registered once per open; read the latest closure through a ref.
  const fetchFromUrlRef = useRef(fetchFromUrl);
  fetchFromUrlRef.current = fetchFromUrl;

  useEffect(() => {
    if (!isOpen) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            handleFileSelect(file);
            return;
          }
        }
      }

      // A link pasted anywhere outside a text field is fetched directly.
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
      if (/^https?:\/\/\S+$/i.test(text)) {
        e.preventDefault();
        setUrlInput(text);
        fetchFromUrlRef.current(text);
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
    // Let the dialog paint before GPU setup starts competing with it for the GPU, then
    // load the model before the OCR worker rather than both at once.
    setImportDialogOpen(true);
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        prewarmBrowserMl()
          .then((backend) => {
            if (!cancelled) setMlBackend(backend);
          })
          .catch(() => {})
          .finally(() => {
            if (!cancelled) prewarmOcrWorker().catch(() => {});
          });
      });
    });
    return () => {
      cancelled = true;
      setImportDialogOpen(false);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
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
    // Never show the previous image's result over a new image.
    setParseResult(null);
    setParseError(null);
    if (!imageUrl) {
      setLoadedImageEl(null);
      setImagePixels(null);
      setOcrCandidates([]);
      setRoomCandidates([]);
      setOcrTextBoxes([]);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
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

      const naturalW = img.naturalWidth || img.width || 600;
      const naturalH = img.naturalHeight || img.height || 450;
      const downscale = Math.min(1, MAX_PROC_DIM / Math.max(naturalW, naturalH));
      const w = Math.max(64, Math.round(naturalW * downscale));
      const h = Math.max(64, Math.round(naturalH * downscale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      setImagePixels({ rgba: ctx.getImageData(0, 0, w, h).data, w, h });
      setLoadedImageEl(img);
    };
    img.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

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
  }, [imagePixels, options.invert]);

  useEffect(() => {
    if (!imagePixels) {
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

    const { rgba, w, h } = imagePixels;
    segmentFloorplanMlBrowser(rgba, w, h, options, ocrTextBoxes)
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
  }, [imagePixels, mlMasks, mlError, options.invert]);

  // Classic CV is used only as an automatic fallback when the model fails.
  useEffect(() => {
    if (!imagePixels) {
      setIsParsing(false);
      return;
    }
    // On the GPU the ML masks arrive within a second; skip the interim non-ML parse.
    if (!mlMasks && !mlError && mlBackend === 'webgpu') {
      setParseResult(null);
      setIsParsing(false);
      return;
    }
    let cancelled = false;
    setIsParsing(true);
    parseFloorplanInWorker({
      rgba: imagePixels.rgba,
      w: imagePixels.w,
      h: imagePixels.h,
      options,
      ocrCandidates,
      useOcrScale,
      roomCandidates,
      ocrTextBoxes,
      masks: mlMasks ?? undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setParseResult(res);
        setParseError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('Floorplan parse failed:', err);
        setParseResult(null);
        setParseError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsParsing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [imagePixels, options, ocrCandidates, useOcrScale, roomCandidates, ocrTextBoxes, mlMasks, mlError, mlBackend]);

  if (!isOpen) return null;

  const handleFetchUrl = (e: React.FormEvent) => {
    e.preventDefault();
    fetchFromUrl(urlInput);
  };

  const handleSelectCandidate = async (candidateUrl: string) => {
    setIsLoadingUrl(true);
    setUrlError(null);
    try {
      setImageBlob(await fetchImageUrlAsBlob(candidateUrl));
    } catch (err: unknown) {
      setUrlError(err instanceof Error ? err.message : 'Could not load selected image from page.');
    } finally {
      setIsLoadingUrl(false);
    }
  };

  const handleLoadSample = () => {
    setUrlError(null);
    setUrlCandidates([]);
    createSampleBlueprintBlob()
      .then(setImageBlob)
      .catch((err) => setUrlError(err instanceof Error ? err.message : String(err)));
  };

  const handleApplyImport = async () => {
    if (!parseResult || !imageBlob || isApplying) return;

    // Store the image before applying, so a reload right after can't lose it.
    let imageId: string | null = null;
    if (includeUnderlay) {
      setIsApplying(true);
      try {
        imageId = await storeUnderlayImage(imageBlob);
      } catch (err) {
        setIsApplying(false);
        setUrlError(`Could not save the image: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      setIsApplying(false);
    }

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
      background: imageId
        ? {
            imageId,
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

  const hasExistingFurniture =
    state.furniture.length > 0 || (state.textBoxes?.length ?? 0) > 0;
  const isBusy = isRunningMl || isScanningOcr || isParsing || isApplying;
  const busyLabel = isRunningMl
    ? mlBackend
      ? 'Running model…'
      : 'Loading model…'
    : isScanningOcr
      ? 'Reading dimensions…'
      : isParsing
        ? 'Detecting walls…'
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
            <p className="import-subtitle">Turn a floorplan image into editable walls, doors, and windows.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="import-modal-body">
          <div className="import-controls-col">
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
                <span className="dropzone-title">Drop, paste, or click to upload</span>
                <span className="dropzone-sub">PNG, JPG, WEBP, or SVG</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelect(file);
                    e.target.value = '';
                  }}
                />
              </div>

              <div className="import-or-divider" aria-hidden="true">
                <span>or paste a link</span>
              </div>

              <form onSubmit={handleFetchUrl} className="url-form">
                <div className="url-input-wrap">
                  <Globe size={13} className="url-input-icon" />
                  <input
                    type="url"
                    inputMode="url"
                    placeholder="Image or listing page URL"
                    aria-label="Floorplan image or listing page URL"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    className="field-input url-input"
                  />
                </div>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={isLoadingUrl || !urlInput.trim()}
                >
                  {isLoadingUrl ? <Loader2 size={14} className="spin" /> : 'Fetch'}
                </button>
              </form>

              {urlCandidates.length > 1 && (
                <div className="candidates-list">
                  <span className="field-label">Images found on page:</span>
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

              <button type="button" className="import-sample-link" onClick={handleLoadSample}>
                No floorplan handy? Try a sample
              </button>
            </div>

            {urlError && (
              <div className="import-alert">
                <AlertCircle size={15} />
                <span>{urlError}</span>
              </div>
            )}

            {imageUrl && (
              <div className="import-config-card">
                {mlError && (
                  <div className="import-alert" role="status">
                    <AlertCircle size={15} />
                    <span>
                      The AI model couldn't run on this device, so a simpler detector was used. Results may need more cleanup.
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

                  {hasExistingFurniture && (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={keepExistingFurniture}
                        onChange={(e) => setKeepExistingFurniture(e.target.checked)}
                      />
                      <span>Keep current furniture on canvas</span>
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="import-preview-col">
            <div className="preview-stage">
              {!imageUrl ? (
                <div className="preview-empty">
                  <FileImage size={36} className="text-slate-300" />
                  <p>Your floorplan preview will appear here</p>
                </div>
              ) : !parseResult && parseError ? (
                <div className="preview-empty" role="alert">
                  <AlertCircle size={32} className="text-slate-300" />
                  <p>Couldn't detect a floorplan in this image. Try a clearer or larger image.</p>
                </div>
              ) : !parseResult ? (
                <div className="preview-pending">
                  <img src={imageUrl} alt="" className="preview-pending-img" />
                  <div className="preview-pending-status" role="status">
                    <Loader2 size={14} className="spin" />
                    <span>{busyLabel ?? 'Detecting walls…'}</span>
                  </div>
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
                    href={imageUrl}
                    x={parseResult.originOffset.x}
                    y={parseResult.originOffset.y}
                    width={parseResult.boundsCm.width}
                    height={parseResult.boundsCm.height}
                    opacity={0.35}
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
