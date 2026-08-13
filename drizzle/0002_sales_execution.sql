CREATE TABLE `saved_views` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `object_type` text DEFAULT 'contact' NOT NULL,
  `filters` text DEFAULT '{}' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_workspace_name_unique` ON `saved_views` (`workspace_id`,`object_type`,`name`);
