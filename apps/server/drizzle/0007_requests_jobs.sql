CREATE TABLE `job_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`at` integer NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_logs_job_idx` ON `job_logs` (`job_id`,`id`);--> statement-breakpoint
ALTER TABLE `book_requests` ADD `cover_url` text;--> statement-breakpoint
ALTER TABLE `book_requests` ADD `published_year` integer;--> statement-breakpoint
ALTER TABLE `book_requests` ADD `rating_reason` text;--> statement-breakpoint
ALTER TABLE `book_requests` ADD `decided_at` integer;--> statement-breakpoint
ALTER TABLE `book_requests` ADD `job_id` text;--> statement-breakpoint
ALTER TABLE `book_requests` ADD `book_id` text REFERENCES books(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `jobs` ADD `label` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `max_attempts` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `progress` real;--> statement-breakpoint
ALTER TABLE `jobs` ADD `result` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `updated_at` integer;