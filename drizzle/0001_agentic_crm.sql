CREATE TABLE `workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `settings` text DEFAULT '{}' NOT NULL,
  `onboarding_status` text DEFAULT 'draft' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `email` text NOT NULL,
  `role` text DEFAULT 'member' NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_email_unique` ON `workspace_members` (`workspace_id`,`email`);
--> statement-breakpoint
INSERT INTO `workspaces` (`id`,`slug`,`name`,`status`,`settings`,`onboarding_status`,`created_at`,`updated_at`)
VALUES ('ws_openoperator','openoperator','OpenOperator','active','{}','live',datetime('now'),datetime('now'));
--> statement-breakpoint
INSERT INTO `workspace_members` (`id`,`workspace_id`,`email`,`role`,`active`,`created_at`)
VALUES ('mem_ty','ws_openoperator','owner@example.com','owner',1,datetime('now'));
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `workspace_id` text NOT NULL DEFAULT 'ws_openoperator';
--> statement-breakpoint
DROP INDEX `contacts_email_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_workspace_email_unique` ON `contacts` (`workspace_id`,`email`);
--> statement-breakpoint
CREATE INDEX `contacts_workspace_stage_idx` ON `contacts` (`workspace_id`,`stage`);
--> statement-breakpoint
ALTER TABLE `sources` ADD COLUMN `workspace_id` text NOT NULL DEFAULT 'ws_openoperator';
--> statement-breakpoint
DROP INDEX `sources_slug_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_workspace_slug_unique` ON `sources` (`workspace_id`,`slug`);
--> statement-breakpoint
ALTER TABLE `activities` ADD COLUMN `workspace_id` text NOT NULL DEFAULT 'ws_openoperator';
--> statement-breakpoint
ALTER TABLE `deals` ADD COLUMN `workspace_id` text NOT NULL DEFAULT 'ws_openoperator';
--> statement-breakpoint
ALTER TABLE `notes` ADD COLUMN `workspace_id` text NOT NULL DEFAULT 'ws_openoperator';
--> statement-breakpoint
CREATE TABLE `pipelines` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `object_type` text DEFAULT 'opportunity' NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);
--> statement-breakpoint
CREATE INDEX `pipelines_workspace_idx` ON `pipelines` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE `pipeline_stages` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `pipeline_id` text NOT NULL,
  `name` text NOT NULL,
  `position` integer NOT NULL,
  `probability` integer DEFAULT 0 NOT NULL,
  `category` text DEFAULT 'open' NOT NULL,
  `color` text DEFAULT '#827b70' NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_stages_position_unique` ON `pipeline_stages` (`pipeline_id`,`position`);
--> statement-breakpoint
CREATE TABLE `opportunities` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `pipeline_id` text NOT NULL,
  `stage_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `name` text NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `value` real DEFAULT 0 NOT NULL,
  `currency` text DEFAULT 'USD' NOT NULL,
  `probability` integer DEFAULT 0 NOT NULL,
  `owner` text,
  `expected_close_at` text,
  `last_activity_at` text,
  `next_step` text,
  `lost_reason` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`),
  FOREIGN KEY (`stage_id`) REFERENCES `pipeline_stages`(`id`),
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `opportunities_workspace_pipeline_idx` ON `opportunities` (`workspace_id`,`pipeline_id`,`stage_id`);
--> statement-breakpoint
CREATE INDEX `opportunities_contact_idx` ON `opportunities` (`workspace_id`,`contact_id`);
--> statement-breakpoint
CREATE TABLE `tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `contact_id` text,
  `opportunity_id` text,
  `title` text NOT NULL,
  `description` text,
  `status` text DEFAULT 'open' NOT NULL,
  `priority` text DEFAULT 'normal' NOT NULL,
  `assignee` text,
  `due_at` text,
  `completed_at` text,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_workspace_due_idx` ON `tasks` (`workspace_id`,`status`,`due_at`);
--> statement-breakpoint
CREATE TABLE `automation_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `trigger_type` text NOT NULL,
  `conditions` text DEFAULT '[]' NOT NULL,
  `actions` text DEFAULT '[]' NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `max_runs_per_record` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `automation_rules_workspace_idx` ON `automation_rules` (`workspace_id`,`status`,`trigger_type`);
--> statement-breakpoint
CREATE TABLE `automation_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `rule_id` text NOT NULL,
  `record_type` text NOT NULL,
  `record_id` text NOT NULL,
  `event_id` text,
  `status` text NOT NULL,
  `step_count` integer DEFAULT 0 NOT NULL,
  `output` text DEFAULT '{}' NOT NULL,
  `error` text,
  `started_at` text NOT NULL,
  `finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_event_unique` ON `automation_runs` (`workspace_id`,`rule_id`,`event_id`);
--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `direction` text NOT NULL,
  `url` text,
  `event_types` text DEFAULT '[]' NOT NULL,
  `secret_prefix` text NOT NULL,
  `secret_hash` text NOT NULL,
  `secret_ciphertext` text NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_endpoints_workspace_idx` ON `webhook_endpoints` (`workspace_id`,`direction`,`active`);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `endpoint_id` text NOT NULL,
  `event_id` text NOT NULL,
  `direction` text NOT NULL,
  `status` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `request_body` text DEFAULT '{}' NOT NULL,
  `response_status` integer,
  `response_excerpt` text,
  `next_attempt_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_delivery_event_unique` ON `webhook_deliveries` (`endpoint_id`,`event_id`,`direction`);
--> statement-breakpoint
CREATE TABLE `agent_proposals` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `contact_id` text,
  `opportunity_id` text,
  `agent_type` text NOT NULL,
  `title` text NOT NULL,
  `rationale` text NOT NULL,
  `confidence` integer NOT NULL,
  `risk_level` text NOT NULL,
  `proposed_action` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `reviewed_by` text,
  `reviewed_at` text,
  `execution_result` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_proposals_workspace_status_idx` ON `agent_proposals` (`workspace_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `audit_log` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `actor_type` text NOT NULL,
  `actor_id` text NOT NULL,
  `action` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `before_state` text,
  `after_state` text,
  `request_id` text NOT NULL,
  `ip_hash` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_workspace_created_idx` ON `audit_log` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `onboarding_checks` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `check_key` text NOT NULL,
  `label` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `details` text DEFAULT '{}' NOT NULL,
  `checked_at` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_checks_workspace_key_unique` ON `onboarding_checks` (`workspace_id`,`check_key`);
--> statement-breakpoint
INSERT INTO `pipelines` (`id`,`workspace_id`,`name`,`object_type`,`active`,`created_at`,`updated_at`)
VALUES ('pipe_openoperator_sales','ws_openoperator','OpenOperator Sales','opportunity',1,datetime('now'),datetime('now'));
--> statement-breakpoint
INSERT INTO `pipeline_stages` (`id`,`workspace_id`,`pipeline_id`,`name`,`position`,`probability`,`category`,`color`,`created_at`) VALUES
('stage_new','ws_openoperator','pipe_openoperator_sales','New lead',0,10,'open','#827b70',datetime('now')),
('stage_qualified','ws_openoperator','pipe_openoperator_sales','Qualified',1,25,'open','#d7a938',datetime('now')),
('stage_booked','ws_openoperator','pipe_openoperator_sales','Call booked',2,45,'open','#5f8dd3',datetime('now')),
('stage_proposal','ws_openoperator','pipe_openoperator_sales','Proposal sent',3,70,'open','#8a63d2',datetime('now')),
('stage_won','ws_openoperator','pipe_openoperator_sales','Won',4,100,'won','#39a968',datetime('now')),
('stage_lost','ws_openoperator','pipe_openoperator_sales','Lost',5,0,'lost','#bd4b43',datetime('now'));
--> statement-breakpoint
INSERT INTO `onboarding_checks` (`id`,`workspace_id`,`check_key`,`label`,`status`,`details`,`created_at`) VALUES
('check_identity','ws_openoperator','identity_access','Owner identity and access policy','passed','{}',datetime('now')),
('check_pipeline','ws_openoperator','pipeline_configured','At least one sales pipeline','passed','{}',datetime('now')),
('check_webhook','ws_openoperator','webhook_security','Webhook signature and replay test','pending','{}',datetime('now')),
('check_automation','ws_openoperator','automation_safety','Automation loop and failure test','pending','{}',datetime('now')),
('check_agent','ws_openoperator','agent_approval','Agent approval policy test','pending','{}',datetime('now')),
('check_load','ws_openoperator','load_test','Concurrency and load test','pending','{}',datetime('now'));
