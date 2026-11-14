/**
 * Tables owned by the job runner (ws/requests). The `jobs` table itself lives in db/schema.ts.
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jobs } from "../db/schema.js";

/** What a job did, step by step, for the admin jobs page. Deleted with the job. */
export const jobLogs = sqliteTable(
  "job_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    at: integer("at", { mode: "number" }).notNull(),
    level: text("level", { enum: ["info", "warn", "error"] }).notNull().default("info"),
    message: text("message").notNull(),
  },
  (t) => [index("job_logs_job_idx").on(t.jobId, t.id)],
);
