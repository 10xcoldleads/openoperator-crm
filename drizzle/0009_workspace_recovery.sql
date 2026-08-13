CREATE TABLE `recovery_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `status` text DEFAULT 'ready' NOT NULL,
  `backup_created_at` text NOT NULL,
  `fingerprint` text NOT NULL,
  `summary` text DEFAULT '{}' NOT NULL,
  `expires_at` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recovery_sessions_workspace_status_idx`
  ON `recovery_sessions` (`workspace_id`,`status`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `recovery_rows` (
  `session_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `table_name` text NOT NULL,
  `row_id` text NOT NULL,
  `row_json` text NOT NULL,
  PRIMARY KEY (`session_id`,`table_name`,`row_id`),
  FOREIGN KEY (`session_id`) REFERENCES `recovery_sessions`(`id`) ON UPDATE no action ON DELETE CASCADE,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recovery_rows_workspace_session_idx`
  ON `recovery_rows` (`workspace_id`,`session_id`,`table_name`);
--> statement-breakpoint
CREATE TABLE `recovery_guard_rows` (
  `session_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `table_name` text NOT NULL,
  `row_id` text NOT NULL,
  `row_json` text NOT NULL,
  PRIMARY KEY (`session_id`,`table_name`,`row_id`),
  FOREIGN KEY (`session_id`) REFERENCES `recovery_sessions`(`id`) ON UPDATE no action ON DELETE CASCADE,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recovery_guard_rows_workspace_session_idx`
  ON `recovery_guard_rows` (`workspace_id`,`session_id`,`table_name`);
