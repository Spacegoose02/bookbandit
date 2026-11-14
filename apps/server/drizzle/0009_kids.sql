CREATE TABLE `reading_bedtimes` (
	`kid_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`weekend_start_minute` integer,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`kid_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `reading_goals` (
	`kid_id` text PRIMARY KEY NOT NULL,
	`minutes_per_day` integer,
	`books_per_month` integer,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`starts_on` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`kid_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `reward_awards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`award` text NOT NULL,
	`key` text DEFAULT '' NOT NULL,
	`book_id` text,
	`emoji` text NOT NULL,
	`earned_at` integer NOT NULL,
	`seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reward_awards_user_award_key_idx` ON `reward_awards` (`user_id`,`award`,`key`);--> statement-breakpoint
CREATE INDEX `reward_awards_user_earned_idx` ON `reward_awards` (`user_id`,`earned_at`);