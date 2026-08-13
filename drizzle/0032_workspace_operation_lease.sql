CREATE TABLE `workspace_operation_leases` (
  `workspace_id` text PRIMARY KEY NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `operation` text NOT NULL CHECK (`operation` IN ('revenue_analysis','workspace_restore')),
  `owner_id` text NOT NULL,
  `lease_until` text NOT NULL,
  `acquired_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspace_operation_leases_expiry_idx`
  ON `workspace_operation_leases` (`lease_until`);
--> statement-breakpoint
INSERT OR IGNORE INTO `workspace_operation_leases`
  (`workspace_id`,`operation`,`owner_id`,`lease_until`,`acquired_at`,`updated_at`)
SELECT `workspace_id`,'revenue_analysis',`run_id`,`lease_until`,`acquired_at`,`updated_at`
FROM `revenue_agent_run_leases`;
