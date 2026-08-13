CREATE TABLE `operations_health_policies` (
  `workspace_id` text PRIMARY KEY NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `target_healthy_percentage` real DEFAULT 99 NOT NULL
    CHECK (`target_healthy_percentage` >= 90 AND `target_healthy_percentage` <= 100),
  `incident_after_consecutive_action` integer DEFAULT 1 NOT NULL
    CHECK (`incident_after_consecutive_action` >= 1 AND `incident_after_consecutive_action` <= 10),
  `notify_on_recovery` integer DEFAULT 1 NOT NULL
    CHECK (`notify_on_recovery` IN (0,1)),
  `revision` integer DEFAULT 1 NOT NULL,
  `change_id` text NOT NULL,
  `updated_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD COLUMN `payload_preset` text DEFAULT 'generic' NOT NULL;
