import type { BookRequest, JobStatus } from "./types";

export type Tone = "wait" | "good" | "bad" | "busy" | "done";

/** What a request's status means to the person looking at it. Kids get short, friendly words. */
export function statusLabel(r: Pick<BookRequest, "status" | "book" | "waitingForReview">, kid = false): { text: string; tone: Tone; emoji: string } {
  switch (r.status) {
    case "pending":
      return kid ? { text: "Waiting for a grown-up", tone: "wait", emoji: "⏳" } : { text: "Waiting for approval", tone: "wait", emoji: "⏳" };
    case "approved":
      return kid ? { text: "Yes! Coming soon", tone: "good", emoji: "👍" } : { text: "Approved", tone: "good", emoji: "👍" };
    case "declined":
      return kid ? { text: "Not this time", tone: "bad", emoji: "🙅" } : { text: "Declined", tone: "bad", emoji: "🙅" };
    case "downloading":
      return kid ? { text: "Barnaby is fetching it", tone: "busy", emoji: "📥" } : { text: "Downloading", tone: "busy", emoji: "📥" };
    case "done":
      if (r.book) return kid ? { text: "Ready to read!", tone: "done", emoji: "🎉" } : { text: "In the library", tone: "done", emoji: "🎉" };
      return kid ? { text: "Almost ready", tone: "busy", emoji: "📦" } : { text: "Arrived, waiting for review in the inbox", tone: "busy", emoji: "📦" };
    case "failed":
      return kid ? { text: "Barnaby couldn't find it", tone: "bad", emoji: "😕" } : { text: "Couldn't get it", tone: "bad", emoji: "😕" };
  }
}

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function percent(p: number | null | undefined): string | null {
  return p == null ? null : `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
}

/** "5 min ago", "3 h ago", "2 days ago", or a date. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} day${Math.round(s / 86_400) === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

export const BOOK_EXTENSIONS = [".epub", ".kepub.epub", ".mobi", ".azw", ".azw3", ".fb2", ".pdf", ".cbz", ".cbr", ".txt", ".zip"];

export function isUploadable(name: string): boolean {
  const lower = name.toLowerCase();
  return BOOK_EXTENSIONS.some((e) => lower.endsWith(e));
}
