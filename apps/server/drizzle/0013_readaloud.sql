CREATE TABLE `narration_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`voice` text,
	`speed` real DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `learning_lookups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text,
	`word` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `learning_lookups_user_idx` ON `learning_lookups` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `learning_quizzes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`section` text NOT NULL,
	`chapter_label` text,
	`questions` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`score` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `learning_quizzes_user_idx` ON `learning_quizzes` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `learning_words` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`word` text NOT NULL,
	`meaning` text NOT NULL,
	`example` text,
	`source` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_words_household_word_idx` ON `learning_words` (`household_id`,`word`);