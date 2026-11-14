import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CONTENT_RATINGS, RATING_LABELS, type ContentRating } from "@bookbandit/shared";
import { Bar, Card, ErrorNote, timeAgo, useAction, useLoad } from "../admin/ui";
import {
  importsApi,
  type FileRef,
  type HouseholdPerson,
  type ImportJob,
  type ImportReport,
  type ImportRequest,
  type ImportSource,
  type ItemStatus,
} from "./api";
import "./imports.css";

const SOURCES: { id: ImportSource; name: string; what: string; icon: string }[] = [
  { id: "calibre", name: "Calibre library", what: "Titles, authors, series, tags, covers", icon: "📚" },
  { id: "calibre-web", name: "Calibre-Web", what: "Who read what, shelves, Kobo positions", icon: "🌐" },
  { id: "kavita", name: "Kavita", what: "Reading progress and collections", icon: "📖" },
  { id: "goodreads", name: "Goodreads or StoryGraph", what: "Reading history, dates and star ratings", icon: "⭐" },
  { id: "google-play", name: "Google Play Books", what: "Your Play Books library, as links", icon: "▶️" },
];

const STATUS_LABEL: Record<ItemStatus, string> = { matched: "Matched", new: "New", skipped: "Skipped", conflict: "Conflicts" };

/** Admin: move in from Calibre, Calibre-Web, Kavita, Goodreads/StoryGraph and Google Play Books. */
export function ImportPage() {
  const [source, setSource] = useState<ImportSource>("calibre");
  const people = useLoad(() => importsApi.people());
  const past = useLoad(() => importsApi.list());
  return (
    <>
      <h1 className="bb-h1">Move in</h1>
      <p className="bb-admin-lede">
        Bring books, reading history and shelves from the apps you used before. Files stay where they are. Every import starts with a
        dry run that shows what would change, and nothing is saved until you press <strong>Import</strong>.
      </p>
      <div className="bb-import-sources" role="tablist" aria-label="Import from">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={source === s.id}
            className={`bb-import-source${source === s.id ? " is-active" : ""}`}
            onClick={() => setSource(s.id)}
          >
            <span className="bb-import-source-icon" aria-hidden>
              {s.icon}
            </span>
            <span className="bb-import-source-name">{s.name}</span>
            <span className="bb-import-source-what">{s.what}</span>
          </button>
        ))}
      </div>
      <ErrorNote error={people.error} />
      <SourceForm key={source} source={source} people={people.data?.items ?? []} onDone={past.reload} />
      <ExportCard people={people.data?.items ?? []} />
      {past.data && past.data.items.length > 0 && (
        <Card title="Earlier imports">
          <ul className="bb-import-past">
            {past.data.items.map((p) => (
              <li key={p.id}>
                <span>{p.label}</span>
                <span className="bb-muted bb-small">
                  {p.status === "failed" ? `failed: ${p.error}` : p.report ? `${p.report.counts.matched} matched, ${p.report.counts.new} new, ${p.report.counts.skipped} skipped, ${p.report.counts.conflict} conflicts` : p.status}
                  {" · "}
                  {timeAgo(p.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-source forms
// ---------------------------------------------------------------------------

function SourceForm({ source, people, onDone }: { source: ImportSource; people: HouseholdPerson[]; onDone: () => void }) {
  const run = useImportRun(onDone);
  // Bumped on every input change, so "Import" needs a fresh dry run of what's on screen.
  const [version, setVersion] = useState(0);
  const [checked, setChecked] = useState(-1);
  const touch = () => setVersion((v) => v + 1);
  const dry = run.job?.status === "done" && run.job.dryRun && checked === version;

  const start = (body: ImportRequest) => {
    if (body.dryRun) setChecked(version);
    void run.start(body);
  };

  const common = { people, touch, busy: run.busy, dry, start };
  return (
    <Card title={SOURCES.find((s) => s.id === source)!.name}>
      {source === "calibre" && <CalibreForm {...common} />}
      {source === "calibre-web" && <CalibreWebForm {...common} report={run.job?.report ?? null} />}
      {source === "kavita" && <KavitaForm {...common} />}
      {source === "goodreads" && <GoodreadsForm {...common} />}
      {source === "google-play" && <GooglePlayForm {...common} />}
      <ErrorNote error={run.error} />
      {run.job && <JobView job={run.job} />}
    </Card>
  );
}

interface FormProps {
  people: HouseholdPerson[];
  touch: () => void;
  busy: boolean;
  /** A dry run of exactly these inputs finished, so the real import may run. */
  dry: boolean;
  start: (body: ImportRequest) => void;
}

function Actions({ ready, busy, dry, onRun }: { ready: boolean; busy: boolean; dry: boolean; onRun: (dryRun: boolean) => void }) {
  return (
    <div className="bb-form-actions">
      <button type="button" className="bb-btn" disabled={!ready || busy} onClick={() => onRun(true)}>
        {busy ? "Working…" : "Dry run"}
      </button>
      <button
        type="button"
        className="bb-btn bb-btn-primary"
        disabled={!ready || busy || !dry}
        title={dry ? undefined : "Do a dry run first"}
        onClick={() => onRun(false)}
      >
        Import
      </button>
      {!dry && <span className="bb-muted bb-small">Check it with a dry run first.</span>}
    </div>
  );
}

function CalibreForm({ touch, busy, dry, start }: FormProps) {
  const [db, setDb] = useState<FileRef | null>(null);
  const [overwrite, setOverwrite] = useState<"calibre" | "fill-gaps">("calibre");
  const [covers, setCovers] = useState(true);
  const [approve, setApprove] = useState(false);
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    touch();
  };
  return (
    <>
      <p className="bb-muted bb-small">
        Reads Calibre's <code>metadata.db</code> and copies the details you curated onto the books Bookbandit scanned from the same
        files. Mount your Calibre folder inside <code>/books</code> (or point both at the same files) and scan first.
      </p>
      <FilePicker label="Calibre library" expected="metadata.db" placeholder="/books/Calibre Library" value={db} onChange={change(setDb)} />
      <fieldset className="bb-import-options">
        <legend>When Calibre and Bookbandit disagree</legend>
        <label className="bb-field bb-field-inline">
          <input type="radio" checked={overwrite === "calibre"} onChange={() => change(setOverwrite)("calibre")} /> Calibre's details win
          (you fixed them there)
        </label>
        <label className="bb-field bb-field-inline">
          <input type="radio" checked={overwrite === "fill-gaps"} onChange={() => change(setOverwrite)("fill-gaps")} /> Keep Bookbandit's,
          only fill empty fields
        </label>
      </fieldset>
      <label className="bb-field bb-field-inline">
        <input type="checkbox" checked={covers} onChange={(e) => change(setCovers)(e.target.checked)} /> Copy Calibre's covers
      </label>
      <label className="bb-field bb-field-inline">
        <input type="checkbox" checked={approve} onChange={(e) => change(setApprove)(e.target.checked)} /> Approve matched books waiting in
        the inbox (their age group stays as it is; unrated books stay grown-ups only)
      </label>
      <Actions ready={!!db} busy={busy} dry={dry} onRun={(dryRun) => db && start({ source: "calibre", dryRun, metadataDb: db, overwrite, covers, approve })} />
    </>
  );
}

function CalibreWebForm({ people, touch, busy, dry, start, report }: FormProps & { report: ImportReport | null }) {
  const [appDb, setAppDb] = useState<FileRef | null>(null);
  const [metadataDb, setMetadataDb] = useState<FileRef | null>(null);
  const [shelves, setShelves] = useState(true);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const outside = report?.source === "calibre-web" ? report.people ?? [] : [];

  // Start from the server's guesses; the admin's picks then stay.
  useEffect(() => {
    if (!outside.length) return;
    setMapping((m) => {
      const missing = outside.filter((p) => !(p.id in m));
      if (!missing.length) return m;
      return { ...m, ...Object.fromEntries(missing.map((p) => [p.id, p.userId])) };
    });
  }, [outside]);

  return (
    <>
      <p className="bb-muted bb-small">
        Brings each person's read and reading books, their shelves (as collections) and Kobo positions from Calibre-Web's{" "}
        <code>app.db</code>. Books are found through your Calibre library, so import that first or choose its <code>metadata.db</code> here too.
      </p>
      <FilePicker
        label="Calibre-Web database"
        expected="app.db"
        placeholder="/config/calibre-web"
        value={appDb}
        onChange={(v) => {
          setAppDb(v);
          touch();
        }}
      />
      <FilePicker
        label="Calibre library (optional after a Calibre import)"
        expected="metadata.db"
        placeholder="/books/Calibre Library"
        value={metadataDb}
        onChange={(v) => {
          setMetadataDb(v);
          touch();
        }}
      />
      <label className="bb-field bb-field-inline">
        <input
          type="checkbox"
          checked={shelves}
          onChange={(e) => {
            setShelves(e.target.checked);
            touch();
          }}
        />{" "}
        Turn shelves into collections (public shelves are shared with the family)
      </label>
      {outside.length > 0 && (
        <PeopleMap
          title="Who is who"
          outside={outside}
          people={people}
          value={mapping}
          onChange={(m) => {
            setMapping(m);
            touch();
          }}
        />
      )}
      <Actions
        ready={!!appDb}
        busy={busy}
        dry={dry}
        onRun={(dryRun) =>
          appDb && start({ source: "calibre-web", dryRun, appDb, ...(metadataDb ? { metadataDb } : {}), people: mapping, shelves })
        }
      />
    </>
  );
}

function KavitaForm({ people, touch, busy, dry, start }: FormProps) {
  const [url, setUrl] = useState("");
  const [rows, setRows] = useState<{ apiKey: string; userId: string | null }[]>([{ apiKey: "", userId: null }]);
  const [collections, setCollections] = useState(true);
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => {
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
    touch();
  };
  const accounts = rows.filter((r) => r.apiKey.trim().length >= 8);
  return (
    <>
      <p className="bb-muted bb-small">
        Kavita keeps progress per account, so add each person's API key (Kavita → your name → Settings → 3rd party clients). Keys are only
        used for this import and stored encrypted with the job.
      </p>
      <label className="bb-field">
        Kavita address
        <input
          className="bb-input"
          type="url"
          placeholder="http://kavita:5000"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            touch();
          }}
        />
      </label>
      <div className="bb-import-keys">
        {rows.map((r, i) => (
          <div key={i} className="bb-import-key">
            <input
              className="bb-input"
              type="password"
              autoComplete="off"
              aria-label={`API key ${i + 1}`}
              placeholder="API key"
              value={r.apiKey}
              onChange={(e) => set(i, { apiKey: e.target.value })}
            />
            <PersonSelect people={people} value={r.userId} onChange={(userId) => set(i, { userId })} label={`Person for API key ${i + 1}`} />
            {rows.length > 1 && (
              <button
                type="button"
                className="bb-btn bb-btn-ghost bb-btn-small"
                onClick={() => {
                  setRows((all) => all.filter((_, j) => j !== i));
                  touch();
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button type="button" className="bb-btn bb-btn-ghost bb-btn-small" onClick={() => setRows((r) => [...r, { apiKey: "", userId: null }])}>
          + Another person
        </button>
      </div>
      <label className="bb-field bb-field-inline">
        <input
          type="checkbox"
          checked={collections}
          onChange={(e) => {
            setCollections(e.target.checked);
            touch();
          }}
        />{" "}
        Bring their collections too
      </label>
      <Actions
        ready={!!url.trim() && accounts.length > 0}
        busy={busy}
        dry={dry}
        onRun={(dryRun) => start({ source: "kavita", dryRun, url: url.trim(), accounts, collections })}
      />
    </>
  );
}

function GoodreadsForm({ people, touch, busy, dry, start }: FormProps) {
  const [file, setFile] = useState<{ uploadId: string } | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [markFinished, setMarkFinished] = useState(true);
  const [wantToRead, setWantToRead] = useState(true);
  const [shelves, setShelves] = useState(false);
  const check = (label: ReactNode, value: boolean, set: (v: boolean) => void) => (
    <label className="bb-field bb-field-inline">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => {
          set(e.target.checked);
          touch();
        }}
      />{" "}
      {label}
    </label>
  );
  return (
    <>
      <p className="bb-muted bb-small">
        Goodreads: My Books → Import and export → Export library. StoryGraph: Manage account → Export StoryGraph library. Every book is
        kept in the person's reading history, even ones the family doesn't own.
      </p>
      <label className="bb-field">
        Whose history is it?
        <PersonSelect
          people={people}
          value={userId}
          onChange={(v) => {
            setUserId(v);
            touch();
          }}
          label="Person"
        />
      </label>
      <UploadField
        label="Export file (.csv)"
        accept=".csv,text/csv"
        onUploaded={(u) => {
          setFile(u);
          touch();
        }}
      />
      {check("Mark books they've read as finished in Bookbandit", markFinished, setMarkFinished)}
      {check(<>Put "want to read" books we have on their <em>Want to read</em> collection</>, wantToRead, setWantToRead)}
      {check("Make collections from their other shelves", shelves, setShelves)}
      <Actions
        ready={!!file && !!userId}
        busy={busy}
        dry={dry}
        onRun={(dryRun) => file && userId && start({ source: "goodreads", dryRun, file, userId, markFinished, wantToRead, shelves })}
      />
    </>
  );
}

function GooglePlayForm({ touch, busy, dry, start }: FormProps) {
  const [file, setFile] = useState<{ uploadId: string } | null>(null);
  const [rating, setRating] = useState<ContentRating | "">("");
  return (
    <>
      <p className="bb-muted bb-small">
        Adds your Play Books library as entries with an <strong>Open in Google Play Books</strong> link, like the Kindle import. Nothing
        is downloaded. Use a CSV with a <code>Title</code> column (plus <code>Author</code>, <code>ISBN</code> or a Play Books link), or the
        JSON of a Google Books "My Library" shelf.
      </p>
      <UploadField
        label="Library file (.csv or .json)"
        accept=".csv,.json,text/csv,application/json"
        onUploaded={(u) => {
          setFile(u);
          touch();
        }}
      />
      <label className="bb-field">
        Age group for new entries
        <select
          className="bb-input"
          value={rating}
          onChange={(e) => {
            setRating(e.target.value as ContentRating | "");
            touch();
          }}
        >
          <option value="">Rate later (grown-ups only until rated)</option>
          {CONTENT_RATINGS.map((r) => (
            <option key={r} value={r}>
              {RATING_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <Actions
        ready={!!file}
        busy={busy}
        dry={dry}
        onRun={(dryRun) => file && start({ source: "google-play", dryRun, file, ...(rating ? { rating } : {}) })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function FilePicker({
  label,
  expected,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  expected: string;
  placeholder: string;
  value: FileRef | null;
  onChange: (v: FileRef | null) => void;
}) {
  const [mode, setMode] = useState<"path" | "upload">("path");
  const [path, setPath] = useState("");
  return (
    <fieldset className="bb-import-file">
      <legend>{label}</legend>
      <div className="bb-import-file-modes">
        <label className="bb-field-inline">
          <input
            type="radio"
            checked={mode === "path"}
            onChange={() => {
              setMode("path");
              onChange(path.trim() ? { path: path.trim() } : null);
            }}
          />{" "}
          Folder on the server
        </label>
        <label className="bb-field-inline">
          <input
            type="radio"
            checked={mode === "upload"}
            onChange={() => {
              setMode("upload");
              onChange(null);
            }}
          />{" "}
          Upload <code>{expected}</code>
        </label>
      </div>
      {mode === "path" ? (
        <input
          className="bb-input"
          aria-label={`${label}: folder or ${expected} path`}
          placeholder={placeholder}
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            onChange(e.target.value.trim() ? { path: e.target.value.trim() } : null);
          }}
        />
      ) : (
        <UploadField label={`${expected} file`} accept={`.db,.sqlite`} onUploaded={(u) => onChange(u)} />
      )}
      {mode === "path" && value && "path" in value && (
        <span className="bb-muted bb-small">The folder that holds {expected}, as the Bookbandit container sees it.</span>
      )}
    </fieldset>
  );
}

function UploadField({ label, accept, onUploaded }: { label: string; accept: string; onUploaded: (u: { uploadId: string } | null) => void }) {
  const action = useAction();
  const [name, setName] = useState<string | null>(null);
  return (
    <div className="bb-field">
      <span>{label}</span>
      <input
        type="file"
        accept={accept}
        aria-label={label}
        onChange={(e) => {
          const file = e.target.files?.[0];
          onUploaded(null);
          setName(null);
          if (!file) return;
          void action.run(async () => {
            const u = await importsApi.upload(file);
            setName(`${file.name} uploaded`);
            onUploaded({ uploadId: u.uploadId });
          });
        }}
      />
      {action.busy && <span className="bb-muted bb-small">Uploading…</span>}
      {name && <span className="bb-ok bb-small">{name}</span>}
      <ErrorNote error={action.error} />
    </div>
  );
}

function PersonSelect({ people, value, onChange, label }: { people: HouseholdPerson[]; value: string | null; onChange: (v: string | null) => void; label: string }) {
  return (
    <select className="bb-input" aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Choose a person…</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.displayName}
          {p.role === "kid" ? " (kid)" : ""}
        </option>
      ))}
    </select>
  );
}

function PeopleMap({
  title,
  outside,
  people,
  value,
  onChange,
}: {
  title: string;
  outside: NonNullable<ImportReport["people"]>;
  people: HouseholdPerson[];
  value: Record<string, string | null>;
  onChange: (v: Record<string, string | null>) => void;
}) {
  return (
    <fieldset className="bb-import-people">
      <legend>{title}</legend>
      {outside.map((p) => (
        <div key={p.id} className="bb-import-person">
          <span>
            <strong>{p.name}</strong>
            {p.email ? <span className="bb-muted bb-small"> {p.email}</span> : null}
            {p.guessed && value[p.id] === p.userId && <span className="bb-tag">our guess</span>}
          </span>
          <select
            className="bb-input"
            aria-label={`Bookbandit person for ${p.name}`}
            value={value[p.id] ?? ""}
            onChange={(e) => onChange({ ...value, [p.id]: e.target.value || null })}
          >
            <option value="">Skip this account</option>
            {people.map((x) => (
              <option key={x.id} value={x.id}>
                {x.displayName}
              </option>
            ))}
          </select>
        </div>
      ))}
    </fieldset>
  );
}

function JobView({ job }: { job: ImportJob }) {
  if (job.status === "queued" || job.status === "running")
    return (
      <div className="bb-import-running" aria-live="polite">
        <p>{job.dryRun ? "Checking…" : "Importing…"}</p>
        <Bar value={job.progress ?? 0} />
      </div>
    );
  if (job.status === "failed" || job.status === "cancelled") return <p className="bb-admin-error">{job.error ?? "The import stopped."}</p>;
  return job.report ? <ReportView report={job.report} /> : null;
}

export function ReportView({ report }: { report: ImportReport }) {
  const [filter, setFilter] = useState<ItemStatus | "all">("all");
  const shown = useMemo(() => report.items.filter((i) => filter === "all" || i.status === filter), [report, filter]);
  const order: ItemStatus[] = ["matched", "new", "skipped", "conflict"];
  return (
    <section className="bb-import-report" aria-live="polite">
      <h3>{report.dryRun ? "Dry run: nothing saved yet" : "Import finished"}</h3>
      <div className="bb-import-counts">
        {order.map((s) => (
          <button key={s} className={`bb-import-count is-${s}${filter === s ? " is-active" : ""}`} onClick={() => setFilter(filter === s ? "all" : s)}>
            <strong>{report.counts[s].toLocaleString()}</strong>
            <span>{STATUS_LABEL[s]}</span>
          </button>
        ))}
      </div>
      {Object.keys(report.stats).length > 0 && (
        <p className="bb-import-stats">
          {Object.entries(report.stats).map(([k, v]) => (
            <span key={k} className="bb-tag">
              {v.toLocaleString()} {k}
            </span>
          ))}
        </p>
      )}
      {report.warnings.length > 0 && (
        <ul className="bb-import-warnings">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <table className="bb-import-items">
          <tbody>
            {shown.slice(0, 300).map((i, n) => (
              <tr key={n}>
                <td>
                  <span className={`bb-import-badge is-${i.status}`}>{STATUS_LABEL[i.status].replace(/s$/, "")}</span>
                </td>
                <td>
                  <div>{i.title}</div>
                  {i.detail && <div className="bb-muted bb-small">{i.detail}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!report.dryRun && (
        <p className="bb-small">
          <Link className="bb-link" to="/browse">
            See the library
          </Link>
        </p>
      )}
    </section>
  );
}

function ExportCard({ people }: { people: HouseholdPerson[] }) {
  const [userId, setUserId] = useState<string | null>(null);
  return (
    <Card title="Export reading history">
      <p className="bb-muted bb-small">
        Download someone's reading history as a Goodreads CSV: what they imported plus everything they finished in Bookbandit. Goodreads,
        StoryGraph and this page can all import it.
      </p>
      <div className="bb-inline-form">
        <PersonSelect people={people} value={userId} onChange={setUserId} label="Person to export" />
        <a
          className={`bb-btn${userId ? "" : " is-disabled"}`}
          aria-disabled={!userId}
          href={userId ? importsApi.exportUrl(userId) : undefined}
          download
        >
          Download CSV
        </a>
      </div>
    </Card>
  );
}

/** Starts an import job and polls it until it ends. */
function useImportRun(onDone: () => void) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const poll = (id: string) => {
    importsApi.job(id).then(
      (j) => {
        setJob(j);
        if (j.status === "queued" || j.status === "running") timer.current = setTimeout(() => poll(id), 1000);
        else {
          setBusy(false);
          onDone();
        }
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };

  const start = async (body: ImportRequest) => {
    setBusy(true);
    setError(null);
    try {
      const { jobId } = await importsApi.start(body);
      setJob({ id: jobId, source: body.source, dryRun: body.dryRun, label: null, status: "queued", progress: 0, error: null, createdAt: Date.now(), finishedAt: null, report: null });
      poll(jobId);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return { job, error, busy, start };
}
