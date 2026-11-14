/** Backup endpoints (server: apps/server/src/backup). Demo mode gets sample data. */
import { isDemo, request } from "../api/client";

export interface BackupInfo {
  name: string;
  createdAt: number;
  sizeBytes: number;
  hasKey: boolean;
  reason: "scheduled" | "manual" | "before-restore" | "unknown";
  version: string | null;
}

export interface BackupStatus {
  dir: string;
  keep: number;
  /** "03:00", or null when nightly backups are off. */
  schedule: string | null;
  nextAt: number | null;
  running: boolean;
  lastError: { at: number; message: string } | null;
  backups: BackupInfo[];
}

const DAY = 86_400_000;
let demoBackups: BackupInfo[] = [1, 2, 3].map((d) => {
  const t = new Date(Date.now() - d * DAY);
  t.setHours(3, 0, 0, 0);
  return {
    name: t.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-"),
    createdAt: t.getTime(),
    sizeBytes: 4_800_000 - d * 20_000,
    hasKey: true,
    reason: "scheduled",
    version: "0.2.0",
  };
});

export const backupApi = {
  async status(): Promise<BackupStatus> {
    if (isDemo) {
      const next = new Date();
      next.setHours(27, 0, 0, 0);
      return { dir: "/config/backups", keep: 7, schedule: "03:00", nextAt: next.getTime(), running: false, lastError: null, backups: demoBackups };
    }
    return request<BackupStatus>("/api/admin/backups");
  },
  async backUpNow(): Promise<BackupInfo> {
    if (isDemo) {
      const b: BackupInfo = {
        name: new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-"),
        createdAt: Date.now(),
        sizeBytes: 4_812_000,
        hasKey: true,
        reason: "manual",
        version: "0.2.0",
      };
      demoBackups = [b, ...demoBackups].slice(0, 7);
      return b;
    }
    return request<BackupInfo>("/api/admin/backups", { method: "POST" });
  },
  downloadUrl: (name: string) => `/api/admin/backups/${encodeURIComponent(name)}/download`,
};
