import { formatCost } from "@bookbandit/shared";
import type { BatchRun, RatingRunStatus } from "./api";

export interface BatchWords {
  /** "Rate", "Check" */
  verb: string;
  /** "Rating…", "Checking…" */
  busy: string;
  /** "unrated books", "books" */
  noun: string;
  /** Shown when every book has been looked at. */
  done: string;
  /** "rating suggestions", "books with fixes" */
  waiting: string;
  /** id of the review list on this page */
  reviewAnchor: string;
}

const BATCH = 25;

/** "about $0.42", or "under $0.01" for tiny amounts. */
const approx = (dollars: number) => (dollars > 0 && dollars < 0.01 ? "under $0.01" : `about ${formatCost(dollars)}`);

/**
 * The shared top of the rating helper and metadata cleanup cards: how far through the library
 * Barnaby is, what's waiting for review, what the rest would cost, and buttons for the next 25,
 * everything left (in the background) or the books that failed.
 */
export function BatchTool({
  run,
  words,
  onStart,
  onStop,
}: {
  run: RatingRunStatus | null;
  words: BatchWords;
  onStart: (r: BatchRun) => void;
  onStop: (jobId: string) => void;
}) {
  const p = run?.progress;
  const est = run?.estimate;
  const running = !!run?.running;
  const remaining = p?.remaining ?? 0;
  const failed = p?.failed ?? 0;
  const looked = p ? p.total - remaining - failed : 0;
  const allDone = !!p && !running && remaining === 0 && failed === 0;
  const next = Math.min(BATCH, remaining);

  const cost = (books: number) => {
    if (!est || !est.provider) return null;
    if (est.free) return "free";
    if (est.perBook == null) return null;
    return approx(est.perBook * books);
  };

  function runAll() {
    const c = cost(remaining);
    if (c && c !== "free" && !window.confirm(`${words.verb} all ${remaining} ${words.noun} in the background? Estimated cost: ${c}.`)) return;
    onStart({ all: true });
  }

  return (
    <div className="bb-batch">
      {p && (
        <>
          <div className="bb-meter" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={looked}>
            <span style={{ width: `${p.total ? Math.min(100, (looked / p.total) * 100) : 100}%` }} />
          </div>
          <p className="bb-batch-line">
            {allDone ? (
              <strong className="bb-batch-done">✓ All done. {words.done}</strong>
            ) : (
              <>
                <strong>{remaining.toLocaleString()}</strong> of {p.total.toLocaleString()} {words.noun} still to go
                {looked > 0 && <span className="bb-muted"> · {looked.toLocaleString()} looked at</span>}
              </>
            )}
          </p>
          {p.waiting > 0 ? (
            <p className="bb-batch-line">
              <strong>{p.waiting.toLocaleString()}</strong> {words.waiting} waiting for you
              {p.fixes != null && p.fixes !== p.waiting && <span className="bb-muted"> ({p.fixes} fixes)</span>} ·{" "}
              <a href={`#${words.reviewAnchor}`}>Review them</a>
            </p>
          ) : (
            allDone && <p className="bb-batch-line bb-muted">Nothing waiting for review.</p>
          )}
          {failed > 0 && !running && (
            <p className="bb-batch-line">
              {failed} {failed === 1 ? "book" : "books"} couldn't be read and {failed === 1 ? "is" : "are"} skipped
              {run?.lastError && <span className="bb-muted"> (last error: {run.lastError})</span>}.{" "}
              <button type="button" className="bb-link-btn" onClick={() => onStart({ retryFailed: true })}>
                Try {failed === 1 ? "it" : "them"} again
              </button>
            </p>
          )}
        </>
      )}

      {running ? (
        <div className="bb-batch-actions">
          <span className="bb-test-result">
            {words.busy} {run!.done}/{run!.total} in the background. You can leave this page.
          </span>
          {run?.jobId && (
            <button type="button" className="bb-btn bb-btn-small" onClick={() => onStop(run.jobId!)}>
              Stop
            </button>
          )}
        </div>
      ) : (
        remaining > 0 && (
          <div className="bb-batch-actions">
            <button type="button" className="bb-btn" onClick={() => onStart({ limit: BATCH })}>
              {words.verb} the next {next}
              {cost(next) && <span className="bb-btn-note"> ({cost(next)})</span>}
            </button>
            {remaining > next && (
              <button type="button" className="bb-btn" onClick={runAll}>
                {words.verb} all {remaining.toLocaleString()} in the background
                {cost(remaining) && <span className="bb-btn-note"> ({cost(remaining)})</span>}
              </button>
            )}
          </div>
        )
      )}

      {est?.provider && (
        <p className="bb-muted bb-small bb-batch-cost">
          {est.free ? (
            <>Runs on {est.provider} ({est.model}) in your house, so it's free.</>
          ) : est.perBook == null ? (
            <>
              Cost unknown: we don't have a price for {est.model}. Add one under <b>Providers</b> to see estimates.
            </>
          ) : (
            <>
              {est.provider} ({est.model}): {approx(est.perBook)} a book
              {remaining > 0 && <>, {approx(est.perBook * remaining)} for the {remaining.toLocaleString()} left</>}
              {est.basis === "guess" ? " (a first guess until a few books have run)" : ""}. Estimates only; check your
              provider's bill.
            </>
          )}
          {run?.spent && run.spent.calls > 0 && !est.free && (
            <>
              {" "}
              Spent so far: {run.spent.partial ? "at least " : ""}
              {formatCost(run.spent.dollars)}.
            </>
          )}
        </p>
      )}
    </div>
  );
}
