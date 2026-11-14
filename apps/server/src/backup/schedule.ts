/** When the nightly backup runs: "HH:MM" in the server's local time zone (TZ), or "off". */
export type BackupTime = { hour: number; minute: number } | null;

export function parseBackupTime(raw: string): BackupTime {
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) throw new Error(`BACKUP_TIME must look like 03:00, or be "off" (got "${raw}")`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`BACKUP_TIME is not a time of day: "${raw}"`);
  return { hour, minute };
}

/** The next time at or after `now` (plus a second) when the clock reads hour:minute. */
export function nextRunAt(time: { hour: number; minute: number }, now: number): number {
  const d = new Date(now);
  d.setHours(time.hour, time.minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
