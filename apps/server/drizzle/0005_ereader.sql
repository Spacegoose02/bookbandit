CREATE TABLE `ereader_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`username` text,
	`secret_hash` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ereader_credentials_username_idx` ON `ereader_credentials` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `ereader_credentials_secret_idx` ON `ereader_credentials` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `ereader_credentials_user_idx` ON `ereader_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `ereader_file_digests` (
	`file_id` text PRIMARY KEY NOT NULL,
	`partial_md5` text NOT NULL,
	`name_md5` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mtime_ms` integer,
	FOREIGN KEY (`file_id`) REFERENCES `book_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ereader_file_digests_partial_idx` ON `ereader_file_digests` (`partial_md5`);--> statement-breakpoint
CREATE INDEX `ereader_file_digests_name_idx` ON `ereader_file_digests` (`name_md5`);--> statement-breakpoint
CREATE TABLE `kobo_reading_states` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `kobo_synced_books` (
	`credential_id` text NOT NULL,
	`book_id` text NOT NULL,
	`synced_at` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`credential_id`, `book_id`),
	FOREIGN KEY (`credential_id`) REFERENCES `ereader_credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `koreader_progress` (
	`user_id` text NOT NULL,
	`document` text NOT NULL,
	`progress` text NOT NULL,
	`percentage` real NOT NULL,
	`device` text NOT NULL,
	`device_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `document`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
