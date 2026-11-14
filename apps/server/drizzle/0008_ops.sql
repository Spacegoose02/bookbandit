CREATE INDEX `book_authors_author_idx` ON `book_authors` (`author_id`);--> statement-breakpoint
CREATE INDEX `book_files_book_idx` ON `book_files` (`book_id`);--> statement-breakpoint
CREATE INDEX `book_series_series_idx` ON `book_series` (`series_id`);--> statement-breakpoint
CREATE INDEX `book_tags_tag_idx` ON `book_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `books_added_idx` ON `books` (`created_at`);