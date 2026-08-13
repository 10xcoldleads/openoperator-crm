ALTER TABLE `company_notes` ADD COLUMN `updated_at` text;
--> statement-breakpoint
UPDATE `company_notes` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
--> statement-breakpoint
CREATE TABLE `company_redirects` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `source_company_id` text NOT NULL,
  `target_company_id` text NOT NULL,
  `source_name` text NOT NULL,
  `merged_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`target_company_id`) REFERENCES `companies`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_redirects_workspace_source_unique`
  ON `company_redirects` (`workspace_id`,`source_company_id`);
--> statement-breakpoint
CREATE INDEX `company_redirects_workspace_target_idx`
  ON `company_redirects` (`workspace_id`,`target_company_id`);
