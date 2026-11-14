import { useCallback, useEffect, useState, type FormEvent } from "react";
import { requestsApi } from "./api";
import { ago, JOB_STATUS_LABEL, percent } from "./status";
import type { Job, JobDetail, JobList, JobStatus } from "./types";

const STATUSES: (JobStatus | "all")[] = ["all", "running", "queued", "failed", "done", "cancelled"];

/** Admin: background jobs (downloads, scans), their logs, retry/cancel, and a direct-URL download. */
export function DownloadsPanel() {
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const [list, setList] = useState<JobList | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    requestsApi.jobs(status === "all" ? {} : { status }).then(setList, (e: Error) => setError(e.message));
  }, [status]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!list?.items.some((j) => j.status === "running" || j.status === "queued")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [list, load]);

  return (
    <div className="bb-downloads">
      <DirectForm onStarted={load} />
      <div className="bb-chips" role="group" aria-label="Show jobs">
        {STATUSES.map((s) => (
          <button key={s} className="bb-chip" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === "all" ? "All" : JOB_STATUS_LABEL[s]}
            {s !== "all" && list?.counts[s] ? ` (${list.counts[s]})` : ""}
          </button>
        ))}
      </div>
      {error && <p className="bb-error">{error}</p>}
      {list && list.items.length === 0 && <p className="bb-muted">No jobs here.</p>}
      <ul className="bb-jobs">
        {list?.items.map((j) => (
          <JobRow key={j.id} job={j} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} onChanged={load} />
        ))}
      </ul>
    </div>
  );
}

function JobRow({ job, open, onToggle, onChanged }: { job: Job; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) requestsApi.job(job.id).then(setDetail, () => setDetail(null));
  }, [open, job.id, job.updatedAt]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const pct = job.status === "running" ? percent(job.progress) : null;

  return (
    <li className={`bb-job is-${job.status}`}>
      <button className="bb-job-head" onClick={onToggle} aria-expanded={open}>
        <span className={`bb-pill is-${job.status === "done" ? "done" : job.status === "failed" ? "bad" : job.status === "cancelled" ? "wait" : "busy"}`}>
          {JOB_STATUS_LABEL[job.status]}
          {pct ? ` ${pct}` : ""}
        </span>
        <span className="bb-job-label">{job.label ?? job.type}</span>
        <span className="bb-muted bb-small">{ago(job.updatedAt ?? job.createdAt)}</span>
      </button>
      {job.status === "running" && job.progress != null && (
        <span className="bb-progress bb-job-progress" aria-hidden>
          <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </span>
      )}
      {open && (
        <div className="bb-job-body">
          {job.lastError && <p className="bb-error bb-small">{job.lastError}</p>}
          <p className="bb-muted bb-small">
            {job.type} · attempt {job.attempts} of {job.maxAttempts}
            {job.status === "queued" && job.runAfter > Date.now() ? ` · next try ${new Date(job.runAfter).toLocaleTimeString()}` : ""}
          </p>
          {detail?.logs.length ? (
            <ol className="bb-log">
              {detail.logs.map((l, i) => (
                <li key={i} className={`is-${l.level}`}>
                  <time>{new Date(l.at).toLocaleTimeString()}</time> {l.message}
                </li>
              ))}
            </ol>
          ) : (
            <p className="bb-muted bb-small">No log lines.</p>
          )}
          <div className="bb-req-actions">
            {(job.status === "failed" || job.status === "cancelled") && (
              <button className="bb-btn" disabled={busy} onClick={() => act(() => requestsApi.retryJob(job.id))}>
                Retry
              </button>
            )}
            {(job.status === "queued" || job.status === "running") && (
              <button className="bb-btn" disabled={busy} onClick={() => act(() => requestsApi.cancelJob(job.id))}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function DirectForm({ onStarted }: { onStarted: () => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [via, setVia] = useState<"direct" | "sabnzbd">("direct");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await requestsApi.directDownload(url.trim(), title.trim() || undefined, via);
      setMsg({ ok: true, text: "Started. It lands in the inbox when it's done." });
      setUrl("");
      setTitle("");
      onStarted();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <form className="bb-rq-panel bb-direct" onSubmit={submit}>
      <h2 className="bb-h2">Download from a link</h2>
      <div className="bb-direct-row">
        <select className="bb-input" value={via} onChange={(e) => setVia(e.target.value as "direct" | "sabnzbd")} aria-label="Kind of link">
          <option value="direct">Book file</option>
          <option value="sabnzbd">NZB (sabnzbd)</option>
        </select>
        <input className="bb-input" type="url" required placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link" />
        <input className="bb-input" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <button className="bb-btn bb-btn-primary" type="submit">
          Download
        </button>
      </div>
      {msg && <p className={`bb-outcome is-${msg.ok ? "good" : "bad"}`}>{msg.text}</p>}
      <p className="bb-muted bb-small">Only download books you're allowed to. Bookbandit never removes DRM.</p>
    </form>
  );
}
