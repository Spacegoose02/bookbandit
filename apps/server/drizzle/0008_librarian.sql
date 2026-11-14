CREATE TABLE `duplicate_ignores` (
	`group_key` text PRIMARY KEY NOT NULL,
	`ignored_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ignored_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
