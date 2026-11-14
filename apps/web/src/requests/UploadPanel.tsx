import { useEffect, useRef, useState } from "react";
import { requestsApi } from "./api";
import { isUploadable } from "./status";

interface Item {
  name: string;
  size: number;
  progress: number;
  state: "waiting" | "uploading" | "done" | "error";
  message?: string;
}

/** Drag-and-drop (or pick) book files; each goes to the server and into the admin inbox. */
export function UploadPanel() {
  const [items, setItems] = useState<Item[]>([]);
  const [maxMb, setMaxMb] = useState(500);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestsApi.uploadAllowed().then((u) => setMaxMb(u.maxMb), () => undefined);
  }, []);

  const patch = (i: number, p: Partial<Item>) => setItems((all) => all.map((x, n) => (n === i ? { ...x, ...p } : x)));

  const add = async (files: File[]) => {
    const start = items.length;
    setItems((all) => [...all, ...files.map((f) => ({ name: f.name, size: f.size, progress: 0, state: "waiting" as const }))]);
    for (const [k, f] of files.entries()) {
      const i = start + k;
      if (!isUploadable(f.name)) {
        patch(i, { state: "error", message: "Not a book file" });
        continue;
      }
      if (f.size > maxMb * 1024 * 1024) {
        patch(i, { state: "error", message: `Larger than ${maxMb} MB` });
        continue;
      }
      patch(i, { state: "uploading" });
      try {
        await requestsApi.upload(f, (p) => patch(i, { progress: p }));
        patch(i, { state: "done", progress: 1, message: "In the inbox once the scan finishes" });
      } catch (e) {
        patch(i, { state: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  return (
    <div className="bb-upload">
      <div
        className={`bb-drop${over ? " is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void add([...e.dataTransfer.files]);
        }}
      >
        <span className="bb-drop-icon" aria-hidden>
          📚
        </span>
        <p>
          <strong>Drop book files here</strong>
          <br />
          <span className="bb-muted">EPUB, KEPUB, MOBI, AZW3, FB2, PDF, CBZ, CBR, TXT or a .zip of them, up to {maxMb} MB each</span>
        </p>
        <button className="bb-btn bb-btn-primary" onClick={() => input.current?.click()}>
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".epub,.kepub,.mobi,.azw,.azw3,.fb2,.pdf,.cbz,.cbr,.txt,.zip"
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {items.length > 0 && (
        <ul className="bb-uploads">
          {items.map((it, i) => (
            <li key={i} className={`bb-upload-row is-${it.state}`}>
              <span className="bb-upload-name">{it.name}</span>
              <span className="bb-muted bb-small">{(it.size / 1048576).toFixed(1)} MB</span>
              <span className="bb-progress bb-upload-progress" aria-label={`${Math.round(it.progress * 100)}%`}>
                <span style={{ width: `${Math.round(it.progress * 100)}%` }} />
              </span>
              <span className="bb-small">{it.state === "done" ? "✅ " : it.state === "error" ? "⚠️ " : ""}{it.message ?? (it.state === "uploading" ? "Uploading…" : "")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
