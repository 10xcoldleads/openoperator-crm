ALTER TABLE `automation_rules` ADD COLUMN `authority_manifest` text DEFAULT '[]' NOT NULL;
ALTER TABLE `automation_rules` ADD COLUMN `authority_hash` text;

ALTER TABLE `automation_runs` ADD COLUMN `principal_id` text;
ALTER TABLE `automation_runs` ADD COLUMN `trigger_actor_type` text;
ALTER TABLE `automation_runs` ADD COLUMN `trigger_actor_id` text;
ALTER TABLE `automation_runs` ADD COLUMN `authority_manifest` text DEFAULT '[]' NOT NULL;
ALTER TABLE `automation_runs` ADD COLUMN `authority_hash` text;

CREATE INDEX `automation_runs_workspace_principal_idx`
  ON `automation_runs` (`workspace_id`,`principal_id`,`started_at`);
