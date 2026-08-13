CREATE TABLE `communication_consents` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `channel` text NOT NULL CHECK (`channel` IN ('email')),
  `status` text NOT NULL CHECK (`status` IN ('unknown','opted_in','opted_out')),
  `basis` text NOT NULL CHECK (`basis` IN ('unknown','express','contractual','inbound_request','manual_suppression')),
  `evidence` text,
  `captured_at` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `communication_consents_contact_channel_unique`
  ON `communication_consents` (`workspace_id`,`contact_id`,`channel`);
CREATE INDEX `communication_consents_workspace_status_idx`
  ON `communication_consents` (`workspace_id`,`channel`,`status`);

CREATE TABLE `conversation_threads` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `contact_id` text,
  `channel` text NOT NULL CHECK (`channel` IN ('email')),
  `provider` text CHECK (`provider` IN ('gmail','outlook')),
  `provider_thread_id` text,
  `participant_email` text NOT NULL,
  `subject` text NOT NULL,
  `status` text NOT NULL DEFAULT 'open' CHECK (`status` IN ('open','closed')),
  `last_message_at` text NOT NULL,
  `unread_count` integer NOT NULL DEFAULT 0 CHECK (`unread_count` >= 0),
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `conversation_threads_workspace_recent_idx`
  ON `conversation_threads` (`workspace_id`,`last_message_at`,`id`);
CREATE INDEX `conversation_threads_workspace_contact_idx`
  ON `conversation_threads` (`workspace_id`,`contact_id`,`last_message_at`);
CREATE UNIQUE INDEX `conversation_threads_workspace_provider_unique`
  ON `conversation_threads` (`workspace_id`,`provider`,`provider_thread_id`);

CREATE TABLE `conversation_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `direction` text NOT NULL CHECK (`direction` IN ('inbound','outbound')),
  `provider` text NOT NULL CHECK (`provider` IN ('gmail','outlook','resend')),
  `provider_message_id` text,
  `idempotency_key` text NOT NULL,
  `from_email` text NOT NULL,
  `to_email` text NOT NULL,
  `subject` text NOT NULL,
  `body_text` text NOT NULL,
  `purpose` text NOT NULL CHECK (`purpose` IN ('inbound','transactional','marketing')),
  `status` text NOT NULL CHECK (`status` IN ('received','pending','sent','failed')),
  `error` text,
  `sent_by` text,
  `occurred_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`thread_id`) REFERENCES `conversation_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `conversation_messages_workspace_idempotency_unique`
  ON `conversation_messages` (`workspace_id`,`idempotency_key`);
CREATE UNIQUE INDEX `conversation_messages_workspace_provider_unique`
  ON `conversation_messages` (`workspace_id`,`provider`,`provider_message_id`)
  WHERE `provider_message_id` IS NOT NULL;
CREATE INDEX `conversation_messages_thread_occurred_idx`
  ON `conversation_messages` (`workspace_id`,`thread_id`,`occurred_at`,`id`);
