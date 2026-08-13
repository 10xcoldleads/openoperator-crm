CREATE TABLE `mailbox_connections` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `owner_email` text NOT NULL,
  `provider` text NOT NULL CHECK (`provider` IN ('gmail','outlook')),
  `toolkit` text NOT NULL CHECK (`toolkit` IN ('gmail','outlook')),
  `alias` text NOT NULL,
  `auth_config_id` text NOT NULL,
  `composio_user_id` text NOT NULL,
  `connected_account_id` text,
  `status` text NOT NULL DEFAULT 'pending'
    CHECK (`status` IN ('pending','active','expired','disabled','revoked','error')),
  `provider_status` text,
  `allowed_capabilities` text NOT NULL DEFAULT '[]',
  `last_synced_at` text,
  `last_error` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text,
  `connect_expires_at` text,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_connections_workspace_provider_alias_unique`
  ON `mailbox_connections` (`workspace_id`,`provider`,`alias`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_connections_composio_account_unique`
  ON `mailbox_connections` (`connected_account_id`)
  WHERE `connected_account_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `mailbox_connections_workspace_status_idx`
  ON `mailbox_connections` (`workspace_id`,`status`,`updated_at`);
