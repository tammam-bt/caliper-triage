/**
 * The specimen viewport — the one element this interface is built around.
 *
 * A dark ground against pale chrome, corner metadata in monospace, a scale bar, and the traced
 * lesion outline drawing itself over the user's own photograph as the features stage completes.
 *
 * Every number on it was measured from those pixels. The contour is the actual segmentation
 * polygon; the principal axes are the actual moments; the dimensions, sharpness and colour are the
 * actual feature values. Nothing on this overlay is decorative, which is the difference between an
 * instrument and a picture of one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageFeatures } from '@caliper/core';

interface Props {
  previewUrl: string | null;
  naturalWidth: number;
  naturalHeight: number;
  features: ImageFeatures | null;
  framePreviews: string[];
  keyFrameIndex: number;
  selectedFrame: number;
  onSelectFrame: (index: number) => void;
  onFiles: (files: FileList | null) => void;
  busy: boolean;
}

export function SpecimenViewport({
  previewUrl, naturalWidth, naturalHeight, features, framePreviews,
  keyFrameIndex, selectedFrame, onSelectFrame, onFiles, busy,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Paste-to-upload. A clinician with a photo on the clipboard should not have to find a file
  // picker, and it costs one listener.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = event.clipboardData?.files;
      if (files && files.length > 0) onFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onFiles]);

  const contourPath = useMemo(() => {
    if (!features || features.contour.length < 3) return null;
    const points = features.contour.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`);
    return `M${points.join('L')}Z`;
  }, [features]);

  // Perimeter drives the draw-on animation's dash offset. An approximation is fine: it only needs
  // to be at least the true length for the stroke to start fully hidden.
  const contourLength = useMemo(() => {
    if (!features) return 0;
    let total = 0;
    const pts = features.contour;
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    }
    return Math.ceil(total * 1.05);
  }, [features]);

  const axes = useMemo(() => {
    if (!features || features.contour.length < 3) return null;
    let sx = 0;
    let sy = 0;
    for (const [x, y] of features.contour) { sx += x; sy += y; }
    const cx = sx / features.contour.length;
    const cy = sy / features.contour.length;
    const r = features.diameterPx / 2;
    return { cx, cy, r };
  }, [features]);

  return (
    <section className="viewport" aria-label="Specimen viewport">
      <div className="viewport__stage">
        {previewUrl ? (
          <figure className="viewport__frame">
            <img
              className="viewport__media"
              src={previewUrl}
              alt="Uploaded specimen"
              width={naturalWidth}
              height={naturalHeight}
            />
            {contourPath && (
              <svg
                className="viewport__overlay"
                viewBox={`0 0 ${naturalWidth} ${naturalHeight}`}
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
              >
                {axes && (
                  <>
                    <line className="axis" x1={axes.cx - axes.r} y1={axes.cy} x2={axes.cx + axes.r} y2={axes.cy} />
                    <line className="axis" x1={axes.cx} y1={axes.cy - axes.r} x2={axes.cx} y2={axes.cy + axes.r} />
                  </>
                )}
                {/* A dark halo under the stroke keeps the cyan legible over pale skin. */}
                <path className="contour-halo" d={contourPath} />
                <path
                  className="contour contour--drawing"
                  d={contourPath}
                  style={{
                    strokeDasharray: contourLength,
                    ['--contour-length' as string]: `${contourLength}`,
                  }}
                />
              </svg>
            )}
          </figure>
        ) : (
          <div className="viewport__empty">
            <div className="graticule" aria-hidden="true">
              <span className="graticule__note">awaiting media</span>
            </div>
            <p className="viewport__prompt">
              Drop a photograph or a short clip here, paste one, or choose a sample case.
              Include a margin of normal skin around the area.
            </p>
            <button type="button" className="button button--quiet" onClick={() => inputRef.current?.click()}>
              Choose a file
            </button>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          className="visually-hidden"
          accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
          onChange={(event) => onFiles(event.target.files)}
        />

        <div
          className="viewport__dropzone"
          data-over={dragOver}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            onFiles(event.dataTransfer.files);
          }}
        />

        {previewUrl && (
          <>
            <dl className="viewport__meta viewport__meta--tl">
              <div className="metric">
                <dt>dim</dt>
                <dd>{naturalWidth}×{naturalHeight}</dd>
              </div>
              {features && (
                <div className="metric">
                  <dt>σ²L</dt>
                  <dd>{features.blurScore.toFixed(1)}</dd>
                </div>
              )}
            </dl>

            {features && (
              <>
                <dl className="viewport__meta viewport__meta--tr">
                  <div className="metric">
                    <dt>A</dt>
                    <dd>{features.asymmetry.toFixed(3)}</dd>
                  </div>
                  <div className="metric">
                    <dt>B</dt>
                    <dd>{features.borderIrregularity.toFixed(2)}</dd>
                  </div>
                  <div className="metric">
                    <dt>C</dt>
                    <dd>{features.colourHeterogeneity.toFixed(2)}</dd>
                  </div>
                </dl>

                <dl className="viewport__meta viewport__meta--bl">
                  <div className="metric">
                    <dt>rgb</dt>
                    <dd>
                      {features.meanColour.map((c) => Math.round(c)).join(' ')}
                    </dd>
                  </div>
                  <div className="metric">
                    <dt>area</dt>
                    <dd>{(features.maskAreaRatio * 100).toFixed(1)}%</dd>
                  </div>
                </dl>

                <div className="viewport__meta viewport__meta--br">
                  <div className="scalebar">
                    <span>
                      {features.diameterMm
                        ? `${features.diameterMm.toFixed(1)} mm`
                        : `${Math.round(features.diameterPx)} px`}
                    </span>
                    <span
                      className="scalebar__rule"
                      style={{
                        // Drawn at the lesion's measured width relative to the frame, clamped so
                        // it stays inside the corner.
                        ['--scalebar-width' as string]:
                          `${Math.min(140, Math.max(36, (features.diameterPx / naturalWidth) * 240))}px`,
                      }}
                    />
                  </div>
                </div>
              </>
            )}

            {busy && !features && (
              <div className="viewport__meta viewport__meta--br">
                <span>measuring…</span>
              </div>
            )}
          </>
        )}
      </div>

      {framePreviews.length > 1 && (
        <div className="framestrip" role="group" aria-label="Sampled video frames">
          {framePreviews.map((src, i) => (
            <button
              key={src || i}
              type="button"
              className="framestrip__item"
              aria-pressed={i === selectedFrame}
              aria-label={`Frame ${i + 1}${i === keyFrameIndex ? ', key frame' : ''}`}
              onClick={() => onSelectFrame(i)}
            >
              <img src={src} alt="" />
              {i === keyFrameIndex && <span className="framestrip__key">KEY</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
