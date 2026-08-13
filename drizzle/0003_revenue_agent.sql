CREATE TABLE `agent_policies` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `mode` text DEFAULT 'copilot' NOT NULL,
  `require_approval` integer DEFAULT 1 NOT NULL,
  `max_proposals_per_run` integer DEFAULT 25 NOT NULL,
  `stale_after_days` integer DEFAULT 7 NOT NULL,
  `high_value_threshold` real DEFAULT 5000 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_policies_workspace_unique` ON `agent_policies` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_type` text NOT NULL,
  `trigger_type` text NOT NULL,
  `status` text NOT NULL,
  `policy_snapshot` text DEFAULT '{}' NOT NULL,
  `observations` text DEFAULT '{}' NOT NULL,
  `proposals_created` integer DEFAULT 0 NOT NULL,
  `proposals_refreshed` integer DEFAULT 0 NOT NULL,
  `proposals_expired` integer DEFAULT 0 NOT NULL,
  `error` text,
  `started_at` text NOT NULL,
  `finished_at` text,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);
--> statement-breakpoint
CREATE INDEX `agent_runs_workspace_started_idx` ON `agent_runs` (`workspace_id`,`started_at`);
--> statement-breakpoint
ALTER TABLE `agent_proposals` ADD COLUMN `run_id` text;
--> statement-breakpoint
ALTER TABLE `agent_proposals` ADD COLUMN `dedupe_key` text;
--> statement-breakpoint
ALTER TABLE `agent_proposals` ADD COLUMN `category` text DEFAULT 'execution' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_proposals` ADD COLUMN `priority` integer DEFAULT 50 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_proposals` ADD COLUMN `expires_at` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_proposals_pending_dedupe_unique`
  ON `agent_proposals` (`workspace_id`,`dedupe_key`) WHERE `status`='pending';
--> statement-breakpoint
INSERT INTO `agent_policies`
  (`id`,`workspace_id`,`mode`,`require_approval`,`max_proposals_per_run`,`stale_after_days`,`high_value_threshold`,`created_at`,`updated_at`)
VALUES
  ('policy_openoperator','ws_openoperator','copilot',1,25,7,5000,datetime('now'),datetime('now'));
