ALTER TABLE `agent_policies` ADD COLUMN `agent_access_enabled` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_policies` ADD COLUMN `workspace_rate_limit_per_minute` integer DEFAULT 120 NOT NULL;
--> statement-breakpoint
CREATE TABLE `agent_workspace_rate_windows` (
  `workspace_id` text PRIMARY KEY NOT NULL,
  `window_start` integer NOT NULL,
  `request_count` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);
