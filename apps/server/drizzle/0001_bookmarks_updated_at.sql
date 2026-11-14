ALTER TABLE `bookmarks` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `bookmarks_user_updated_idx` ON `bookmarks` (`user_id`,`updated_at`);