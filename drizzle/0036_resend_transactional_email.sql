CREATE TABLE `resend_connections` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `label` text NOT NULL,
  `api_key_prefix` text NOT NULL,
  `api_key_ciphertext` text NOT NULL,
  `from_email` text NOT NULL,
  `from_name` text,
  `reply_to` text,
  `status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','active','error','revoked')),
  `last_verified_at` text,
  `last_error` text,
  `revision` integer DEFAULT 1 NOT NULL,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `resend_connections_workspace_active_unique` ON `resend_connections` (`workspace_id`) WHERE `status` <> 'revoked';
CREATE INDEX `resend_connections_workspace_status_idx` ON `resend_connections` (`workspace_id`,`status`);

CREATE TABLE `resend_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `recipient` text NOT NULL,
  `subject` text NOT NULL,
  `body_excerpt` text NOT NULL,
  `provider_email_id` text,
  `status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','succeeded','failed')),
  `response_status` integer,
  `error` text,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connection_id`) REFERENCES `resend_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `resend_deliveries_workspace_idempotency_unique` ON `resend_deliveries` (`workspace_id`,`idempotency_key`);
CREATE INDEX `resend_deliveries_workspace_created_idx` ON `resend_deliveries` (`workspace_id`,`created_at`);
