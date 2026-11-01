ALTER TABLE `messages` ADD `size` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `messages_user_size_idx` ON `messages` (`user_id`,`size`);
--> statement-breakpoint
ALTER TABLE `app_settings` RENAME COLUMN `drive_storage_limit_bytes` TO `storage_limit_bytes`;
