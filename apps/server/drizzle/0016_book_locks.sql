ALTER TABLE `books` ADD `original_title` text;--> statement-breakpoint
ALTER TABLE `books` ADD `locked_fields` text DEFAULT '[]' NOT NULL;