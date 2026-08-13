ALTER TABLE `automation_runs` ADD COLUMN `retry_of_run_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_retry_once_unique`
  ON `automation_runs` (`workspace_id`,`retry_of_run_id`)
  WHERE `retry_of_run_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `automation_runs_workspace_status_idx`
  ON `automation_runs` (`workspace_id`,`status`,`started_at`);
