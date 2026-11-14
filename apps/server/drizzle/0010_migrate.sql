CREATE TABLE `book_identifiers` (
	`book_id` text NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_identifiers_idx` ON `book_identifiers` (`book_id`,`type`);--> statement-breakpoint
CREATE INDEX `book_identifiers_value_idx` ON `book_identifiers` (`type`,`value`);--> statement-breakpoint
CREATE TABLE `import_links` (
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`book_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_links_idx` ON `import_links` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `import_links_book_idx` ON `import_links` (`book_id`);--> statement-breakpoint
CREATE TABLE `reading_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text,
	`title` text NOT NULL,
	`author` text,
	`isbn13` text,
	`status` text NOT NULL,
	`stars` real,
	`review` text,
	`shelves` text,
	`read_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`added_at` integer,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reading_history_source_idx` ON `reading_history` (`user_id`,`source`,`source_key`);--> statement-breakpoint
CREATE INDEX `reading_history_user_idx` ON `reading_history` (`user_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `reading_history_book_idx` ON `reading_history` (`book_id`);