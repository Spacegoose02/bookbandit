import { useState } from "react";
import { Link } from "react-router-dom";
import { CONTENT_RATINGS, RATING_LABELS, type ContentRating } from "@bookbandit/shared";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { discoverApi, type KindleImportReport } from "./api";
import "./discover.css";

const SAMPLE = `ASIN,Title,Author
B00ZV9PXP2,Mistborn: The Final Empire,Brandon Sanderson
B08FHBV4ZX,Project Hail Mary,Andy Weir`;

/** Admin: turn a Kindle library CSV into metadata-only "On Kindle" books. */
export function KindleImportPage() {
  const { me } = useSession();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [rating, setRating] = useState<ContentRating | "">("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<KindleImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (me && me.role !== "admin")
    return (
      <BarnabyEmpty title="Grown-up admins only">
        <p>Ask the person who runs your library to import Kindle books.</p>
      </BarnabyEmpty>
    );

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setReport(await discoverApi.kindleImport(csv, { rating: rating || undefined, dryRun }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setCsv(await file.text());
    setReport(null);
  };

  return (
    <div className="bb-page bb-kindle-import">
      <p className="bb-small">
        <Link className="bb-link" to="/discover">
          ← Discover
        </Link>
      </p>
      <h1 className="bb-h1">Import your Kindle library</h1>
      <p className="bb-muted">
        Adds each Kindle book as a library entry with a <strong>Read in Kindle</strong> button. No files are downloaded and
        nothing is converted: the book still opens in Amazon's Kindle app. Books you already have as files just get the Kindle
        link added.
      </p>
      <ol className="bb-steps">
        <li>
          Export your Kindle library as a CSV (a Kindle library exporter, or Amazon's "Digital Items" order report) with at least a{" "}
          <code>Title</code> column, ideally <code>ASIN</code> and <code>Author</code> too.
        </li>
        <li>Choose the file or paste it below, check it with a dry run, then import.</li>
      </ol>

      <div className="bb-field">
        <label htmlFor="kindle-file">CSV file</label>
        <input id="kindle-file" type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
        {fileName && <span className="bb-small bb-muted">{fileName}</span>}
      </div>
      <div className="bb-field">
        <label htmlFor="kindle-csv">…or paste it</label>
        <textarea
          id="kindle-csv"
          className="bb-input bb-csv"
          rows={8}
          placeholder={SAMPLE}
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setReport(null);
          }}
        />
      </div>
      <div className="bb-field">
        <label htmlFor="kindle-rating">Age group for new entries</label>
        <select id="kindle-rating" className="bb-input" value={rating} onChange={(e) => setRating(e.target.value as ContentRating | "")}>
          <option value="">Rate later (grown-ups only until rated)</option>
          {CONTENT_RATINGS.map((r) => (
            <option key={r} value={r}>
              {RATING_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <div className="bb-actions">
        <button className="bb-btn" disabled={!csv.trim() || busy} onClick={() => run(true)}>
          Dry run
        </button>
        <button className="bb-btn bb-btn-primary" disabled={!csv.trim() || busy} onClick={() => run(false)}>
          {busy ? "Working…" : "Import"}
        </button>
      </div>
      {error && <p className="bb-error">{error}</p>}
      {report && (
        <section className="bb-report" aria-live="polite">
          <h2>{report.dryRun ? "Dry run: nothing saved yet" : "Import finished"}</h2>
          <ul className="bb-report-stats">
            <li>
              <strong>{report.created}</strong> new Kindle books
            </li>
            <li>
              <strong>{report.linked}</strong> existing books linked to Kindle
            </li>
            <li>
              <strong>{report.skipped}</strong> already imported
            </li>
          </ul>
          {report.errors.length > 0 && (
            <details>
              <summary>{report.errors.length} rows need a look</summary>
              <ul className="bb-small">
                {report.errors.slice(0, 50).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          )}
          {!report.dryRun && (
            <Link className="bb-link" to="/browse?q=">
              See them in the library
            </Link>
          )}
        </section>
      )}
    </div>
  );
}
