import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Cover, ErrorNote, useAction, useLoad } from "../admin/ui";
import { librarianApi, type LibBook } from "./api";
import { clampPan, sourceRect } from "./crop";

const FRAME_W = 220;
const FRAME_H = 330;
const OUT_W = 600;
const OUT_H = 900;

/** Pick a cover from the book's files or the online lookup, upload one, or crop the current one. */
export function CoverEditor({ book, onClose, onSaved }: { book: LibBook; onClose: () => void; onSaved: (b: LibBook) => void }) {
  const covers = useLoad(() => librarianApi.covers(book.id), [book.id]);
  const [picked, setPicked] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const save = useAction();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal?.();
  }, []);

  const current = librarianApi.coverUrl(book);
  const cands = covers.data?.candidates ?? [];
  const choice = cands.find((c) => c.url === picked);

  const useCandidate = () =>
    save.run(async () => {
      if (!choice) return;
      onSaved(await librarianApi.setCover(book.id, choice.fileId ? { fileId: choice.fileId } : { url: choice.url }));
    });

  return (
    <dialog ref={dialog} className="bb-cover-editor" aria-label={`Cover for ${book.title}`} onCancel={onClose}>
      <header className="bb-cover-head">
        <div>
          <h2>Cover</h2>
          <p className="bb-muted bb-small">{book.title}</p>
        </div>
        <button className="bb-btn bb-btn-small bb-btn-ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {cropSrc ? (
        <Cropper
          src={cropSrc}
          busy={save.busy}
          onCancel={() => setCropSrc(null)}
          onSave={(image) => save.run(async () => onSaved(await librarianApi.setCover(book.id, { image })))}
        />
      ) : (
        <div className="bb-cover-body">
          <div className="bb-cover-current">
            <Cover src={current} title={book.title} size={140} />
            <div className="bb-cover-current-actions">
              {current && (
                <button className="bb-btn bb-btn-small" onClick={() => setCropSrc(current)}>
                  Crop this cover
                </button>
              )}
              <label className="bb-btn bb-btn-small bb-cover-upload">
                Upload an image…
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setCropSrc(URL.createObjectURL(f));
                  }}
                />
              </label>
            </div>
          </div>
          <div className="bb-cover-cands">
            <h3 className="bb-small">Choose one</h3>
            {!covers.data && !covers.error && <p className="bb-muted">Looking up covers…</p>}
            {covers.data && cands.length === 0 && <p className="bb-muted">No covers found in the files or online. Upload one instead.</p>}
            <div className="bb-cover-grid" role="radiogroup" aria-label="Cover choices">
              {cands.map((c) => (
                <button key={c.url} role="radio" aria-checked={picked === c.url} className="bb-cover-cand" onClick={() => setPicked(c.url)}>
                  <img src={c.url} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).closest("button")!.hidden = true)} />
                  <span className="bb-small">{c.label}</span>
                </button>
              ))}
            </div>
            {covers.data?.errors.length ? <p className="bb-muted bb-small">Some lookups failed: {covers.data.errors.join("; ")}</p> : null}
          </div>
        </div>
      )}
      <ErrorNote error={covers.error ?? save.error} />
      {!cropSrc && (
        <footer className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={!choice || save.busy} onClick={useCandidate}>
            Use this cover
          </button>
          <button className="bb-btn bb-btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </footer>
      )}
    </dialog>
  );
}

/** Drag to move, slider to zoom; saves a 600×900 JPEG of what's inside the frame. */
function Cropper({ src, busy, onCancel, onSave }: { src: string; busy: boolean; onCancel: () => void; onSave: (dataUrl: string) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ dx: 0, dy: 0 });
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const view = size ? { imgW: size.w, imgH: size.h, frameW: FRAME_W, frameH: FRAME_H, zoom, ...pan } : null;
  const clamped = view ? clampPan(view) : pan;
  const scale = view ? Math.max(FRAME_W / view.imgW, FRAME_H / view.imgH) * zoom : 1;

  const onDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ...clamped };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag.current || !view) return;
    setPan(clampPan({ ...view, dx: drag.current.dx + e.clientX - drag.current.x, dy: drag.current.dy + e.clientY - drag.current.y }));
  };

  const save = () => {
    if (!view || !img.current) return;
    const { sx, sy, sw, sh } = sourceRect(view);
    const canvas = document.createElement("canvas");
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const ctx = canvas.getContext("2d")!;
    try {
      ctx.drawImage(img.current, sx, sy, sw, sh, 0, 0, OUT_W, OUT_H);
      onSave(canvas.toDataURL("image/jpeg", 0.9));
    } catch {
      setError("This image can't be cropped here. Pick it from the list instead, then crop the saved cover.");
    }
  };

  return (
    <div className="bb-cropper">
      <div
        className="bb-crop-frame"
        style={{ width: FRAME_W, height: FRAME_H }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <img
          ref={img}
          src={src}
          alt=""
          draggable={false}
          crossOrigin={src.startsWith("http") ? "anonymous" : undefined}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth || 200, h: e.currentTarget.naturalHeight || 300 })}
          style={
            size
              ? {
                  width: size.w * scale,
                  height: size.h * scale,
                  transform: `translate(calc(-50% + ${clamped.dx}px), calc(-50% + ${clamped.dy}px))`,
                }
              : { visibility: "hidden" }
          }
        />
      </div>
      <div className="bb-crop-controls">
        <label className="bb-field">
          Zoom
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
        </label>
        <p className="bb-muted bb-small">Drag the picture to choose what shows on the cover.</p>
        <ErrorNote error={error} />
        <div className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={!size || busy} onClick={save}>
            Save cover
          </button>
          <button className="bb-btn bb-btn-ghost" onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
