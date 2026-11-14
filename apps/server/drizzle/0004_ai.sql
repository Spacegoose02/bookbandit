CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text,
	`title` text NOT NULL,
	`kid` integer DEFAULT false NOT NULL,
	`flagged` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_conversations_user_idx` ON `ai_conversations` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `ai_kid_settings` (
	`kid_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`web_search` integer DEFAULT false NOT NULL,
	`daily_limit` integer DEFAULT 30 NOT NULL,
	`set_by` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`kid_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `ai_message_sources` (
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`book_id` text,
	PRIMARY KEY(`message_id`, `position`),
	FOREIGN KEY (`message_id`) REFERENCES `ai_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_rating_suggestions` (
	`book_id` text PRIMARY KEY NOT NULL,
	`rating` text NOT NULL,
	`confidence` real NOT NULL,
	`reasons` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`feature` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`duration_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_idx` ON `ai_usage` (`created_at`);