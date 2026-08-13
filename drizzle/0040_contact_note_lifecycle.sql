ALTER TABLE `notes` ADD COLUMN `updated_at` text;

UPDATE `notes` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
