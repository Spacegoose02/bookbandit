CREATE TABLE `reading_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`kind` text DEFAULT 'read' NOT NULL,
	`device_name` text,
	`started_at` integer NOT NULL,
	`last_beat_at` integer NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reading_sessions_user_started_idx` ON `reading_sessions` (`user_id`,`started_at`);