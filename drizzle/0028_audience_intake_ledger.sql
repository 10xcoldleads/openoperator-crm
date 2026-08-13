ALTER TABLE `visitor_profiles` ADD COLUMN `origin_import_id` text;
--> statement-breakpoint

CREATE TABLE `audience_imports` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `connector_id` text NOT NULL,
  `provider` text NOT NULL CHECK (`provider` IN ('audiencelab')),
  `external_key` text NOT NULL,
  `list_name` text NOT NULL,
  `mode` text NOT NULL CHECK (`mode` IN ('interactive','full_refresh','incremental')),
  `consent_basis` text NOT NULL CHECK (`consent_basis` IN ('unknown','granted','denied')),
  `tags` text NOT NULL DEFAULT '[]',
  `requested_rows` integer NOT NULL,
  `created_profiles` integer NOT NULL DEFAULT 0,
  `updated_profiles` integer NOT NULL DEFAULT 0,
  `repeated_rows` integer NOT NULL DEFAULT 0,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connector_id`) REFERENCES `visitor_connectors`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audience_imports_connector_external_key_unique`
  ON `audience_imports` (`connector_id`,`external_key`);
--> statement-breakpoint
CREATE INDEX `audience_imports_workspace_created_idx`
  ON `audience_imports` (`workspace_id`,`created_at`,`id`);
--> statement-breakpoint

CREATE TABLE `audience_import_members` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `import_id` text NOT NULL,
  `profile_id` text NOT NULL,
  `row_key` text NOT NULL,
  `outcome` text NOT NULL CHECK (`outcome` IN ('created','updated','repeated')),
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`import_id`) REFERENCES `audience_imports`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`profile_id`) REFERENCES `visitor_profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audience_import_members_import_row_unique`
  ON `audience_import_members` (`import_id`,`row_key`);
--> statement-breakpoint
CREATE INDEX `audience_import_members_profile_idx`
  ON `audience_import_members` (`workspace_id`,`profile_id`,`created_at`);
