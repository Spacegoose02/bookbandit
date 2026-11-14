CREATE TABLE `abs_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`abs_user_id` text NOT NULL,
	`abs_username` text NOT NULL,
	`token_sealed` text NOT NULL,
	`write_back` integer DEFAULT true NOT NULL,
	`last_import_at` integer,
	`last_push_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audio_bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`time_seconds` real NOT NULL,
	`note` text,
	`origin` text DEFAULT 'bookbandit' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audio_bookmarks_user_book_idx` ON `audio_bookmarks` (`user_id`,`book_id`);--> statement-breakpoint
CREATE TABLE `audio_prefs` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`speed` real DEFAULT 1 NOT NULL,
	`skip_silence` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audiobooks` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`signature` text NOT NULL,
	`tracks` text NOT NULL,
	`chapters` text NOT NULL,
	`duration_seconds` real DEFAULT 0 NOT NULL,
	`narrator` text,
	`cover_rel_path` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audiobooks_path_idx` ON `audiobooks` (`rel_path`);--> statement-breakpoint
CREATE INDEX `audiobooks_book_idx` ON `audiobooks` (`book_id`);