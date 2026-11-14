CREATE TABLE `storyteller_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kid_id` text NOT NULL,
	`book_id` text NOT NULL,
	`mode` text NOT NULL,
	`night` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_beat_at` integer NOT NULL,
	`ended_at` integer,
	`completed` integer DEFAULT false NOT NULL,
	`listened_ms` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`kid_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `storyteller_sessions_kid_night_idx` ON `storyteller_sessions` (`kid_id`,`night`);--> statement-breakpoint
CREATE TABLE `storyteller_settings` (
	`kid_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`stories_per_night` integer,
	`minutes_per_night` integer,
	`sleep_timer_minutes` integer,
	`read_aloud` integer DEFAULT true NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`night_starts_hour` integer DEFAULT 12 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`kid_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
