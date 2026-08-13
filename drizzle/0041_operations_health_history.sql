CREATE TABLE `operations_health_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `observed_minute` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('healthy','watch','action')),
  `attention_count` integer NOT NULL,
  `components` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_health_snapshots_workspace_minute_unique`
  ON `operations_health_snapshots` (`workspace_id`,`observed_minute`);
--> statement-breakpoint
CREATE INDEX `operations_health_snapshots_workspace_created_idx`
  ON `operations_health_snapshots` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `operations_health_incidents` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL CHECK (`status` IN ('open','resolved')),
  `severity` text NOT NULL CHECK (`severity` IN ('action')),
  `component_ids` text NOT NULL,
  `opened_at` text NOT NULL,
  `last_observed_at` text NOT NULL,
  `resolved_at` text,
  `opening_event_id` text NOT NULL,
  `recovery_event_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_health_incidents_workspace_open_unique`
  ON `operations_health_incidents` (`workspace_id`) WHERE `status`='open';
--> statement-breakpoint
CREATE INDEX `operations_health_incidents_workspace_opened_idx`
  ON `operations_health_incidents` (`workspace_id`,`opened_at`);
--> statement-breakpoint
CREATE TABLE `operations_health_scheduler_state` (
  `job` text PRIMARY KEY NOT NULL,
  `cursor_workspace_id` text,
  `updated_at` text NOT NULL
);
