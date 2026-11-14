CREATE TABLE `audio_progress` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`abs_item_id` text NOT NULL,
	`position_seconds` real DEFAULT 0 NOT NULL,
	`duration_seconds` real DEFAULT 0 NOT NULL,
	`finished` integer DEFAULT false NOT NULL,
	`device_name` text,
	`client_updated_at` integer NOT NULL,
	`server_updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audio_progress_user_idx` ON `audio_progress` (`user_id`,`server_updated_at`);--> statement-breakpoint
CREATE TABLE `kindle_addresses` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`set_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
