CREATE TABLE `agent_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `provider` text DEFAULT 'custom' NOT NULL,
  `key_prefix` text NOT NULL,
  `key_hash` text NOT NULL,
  `scopes` text DEFAULT '[]' NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `rate_limit_per_minute` integer DEFAULT 60 NOT NULL,
  `last_used_at` text,
  `expires_at` text,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `revoked_at` text,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_credentials_key_hash_unique` ON `agent_credentials` (`key_hash`);
--> statement-breakpoint
CREATE INDEX `agent_credentials_workspace_active_idx` ON `agent_credentials` (`workspace_id`,`active`);
--> statement-breakpoint
CREATE TABLE `agent_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `credential_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `tool_name` text NOT NULL,
  `arguments_hash` text NOT NULL,
  `status` text NOT NULL,
  `response_json` text,
  `proposal_id` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`credential_id`) REFERENCES `agent_credentials`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_requests_credential_idempotency_unique`
  ON `agent_requests` (`credential_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `agent_requests_workspace_created_idx` ON `agent_requests` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_rate_windows` (
  `credential_id` text PRIMARY KEY NOT NULL,
  `window_start` integer NOT NULL,
  `request_count` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`credential_id`) REFERENCES `agent_credentials`(`id`)
);
