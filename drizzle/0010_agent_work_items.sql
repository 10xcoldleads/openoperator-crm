CREATE TABLE `agent_work_items` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `automation_rule_id` text,
  `automation_run_id` text,
  `contact_id` text,
  `opportunity_id` text,
  `objective` text NOT NULL,
  `instructions` text NOT NULL,
  `preferred_provider` text DEFAULT 'any' NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `claimed_by_credential_id` text,
  `claim_expires_at` text,
  `result` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`automation_rule_id`) REFERENCES `automation_rules`(`id`),
  FOREIGN KEY (`automation_run_id`) REFERENCES `automation_runs`(`id`),
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`),
  FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`),
  FOREIGN KEY (`claimed_by_credential_id`) REFERENCES `agent_credentials`(`id`)
);
--> statement-breakpoint
CREATE INDEX `agent_work_items_workspace_queue_idx`
  ON `agent_work_items` (`workspace_id`,`status`,`preferred_provider`,`created_at`);
--> statement-breakpoint
CREATE INDEX `agent_work_items_claim_idx`
  ON `agent_work_items` (`claimed_by_credential_id`,`status`,`claim_expires_at`);
