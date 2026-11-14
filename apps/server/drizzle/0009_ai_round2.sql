CREATE TABLE `ai_book_embeddings` (
	`book_id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`dims` integer NOT NULL,
	`vector` blob NOT NULL,
	`text_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_book_embeddings_model_idx` ON `ai_book_embeddings` (`model`);--> statement-breakpoint
CREATE TABLE `ai_metadata_checks` (
	`book_id` text PRIMARY KEY NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_metadata_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`field` text NOT NULL,
	`current` text,
	`suggested` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_metadata_suggestions_book_field_idx` ON `ai_metadata_suggestions` (`book_id`,`field`);--> statement-breakpoint
CREATE INDEX `ai_metadata_suggestions_status_idx` ON `ai_metadata_suggestions` (`status`);