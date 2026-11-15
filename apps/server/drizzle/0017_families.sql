CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `families_household_idx` ON `families` (`household_id`);--> statement-breakpoint
CREATE TABLE `family_picks` (
	`family_id` text NOT NULL,
	`book_id` text NOT NULL,
	`added_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`family_id`, `book_id`),
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `family_id` text REFERENCES families(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `users` ADD `family_id` text REFERENCES families(id) ON DELETE set null;--> statement-breakpoint
-- Everyone already here is one family: put each household's people and tablets in a family of the same name.
INSERT INTO `families` (`id`, `household_id`, `name`) SELECT `id`, `id`, `name` FROM `households`;--> statement-breakpoint
UPDATE `users` SET `family_id` = `household_id`;--> statement-breakpoint
UPDATE `devices` SET `family_id` = `household_id`;
