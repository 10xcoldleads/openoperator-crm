CREATE TABLE `revenue_agent_run_leases` (
  `workspace_id` text PRIMARY KEY NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `run_id` text NOT NULL,
  `lease_until` text NOT NULL,
  `acquired_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `revenue_agent_run_leases_expiry_idx`
  ON `revenue_agent_run_leases` (`lease_until`);
