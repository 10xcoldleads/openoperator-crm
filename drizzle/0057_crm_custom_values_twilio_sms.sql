CREATE TABLE `crm_custom_values` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `value_key` text NOT NULL CHECK (`value_key` GLOB '[a-z]*' AND length(`value_key`) BETWEEN 2 AND 60),
  `label` text NOT NULL,
  `value` text NOT NULL,
  `folder` text,
  `active` integer NOT NULL DEFAULT 1 CHECK (`active` IN (0,1)),
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `crm_custom_values_workspace_key_unique`
  ON `crm_custom_values` (`workspace_id`,`value_key`);
CREATE INDEX `crm_custom_values_workspace_folder_idx`
  ON `crm_custom_values` (`workspace_id`,`active`,`folder`,`label`);

CREATE TABLE `twilio_connections` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `label` text NOT NULL,
  `account_sid` text NOT NULL CHECK (`account_sid` GLOB 'AC[0-9a-fA-F]*' AND length(`account_sid`)=34),
  `auth_token_prefix` text NOT NULL,
  `auth_token_ciphertext` text NOT NULL,
  `messaging_service_sid` text NOT NULL CHECK (`messaging_service_sid` GLOB 'MG[0-9a-fA-F]*' AND length(`messaging_service_sid`)=34),
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','active','error','revoked')),
  `advanced_opt_out_status` text NOT NULL DEFAULT 'unverified' CHECK (`advanced_opt_out_status` IN ('unverified','enabled','disabled')),
  `last_verified_at` text,
  `last_error` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `twilio_connections_workspace_active_unique`
  ON `twilio_connections` (`workspace_id`) WHERE `status` <> 'revoked';
CREATE INDEX `twilio_connections_workspace_status_idx`
  ON `twilio_connections` (`workspace_id`,`status`);

CREATE TABLE `sms_consents` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `status` text NOT NULL DEFAULT 'unknown' CHECK (`status` IN ('unknown','opted_in','opted_out')),
  `basis` text NOT NULL DEFAULT 'unknown' CHECK (`basis` IN ('unknown','express','contractual','inbound_request','manual_suppression','provider_stop')),
  `evidence` text,
  `captured_at` text,
  `provider_opt_out_type` text CHECK (`provider_opt_out_type` IN ('STOP','START','HELP')),
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `sms_consents_contact_unique`
  ON `sms_consents` (`workspace_id`,`contact_id`);
CREATE INDEX `sms_consents_workspace_status_idx`
  ON `sms_consents` (`workspace_id`,`status`);

CREATE TABLE `sms_threads` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `contact_id` text,
  `participant_phone` text NOT NULL,
  `status` text NOT NULL DEFAULT 'open' CHECK (`status` IN ('open','closed','quarantined')),
  `last_message_at` text NOT NULL,
  `unread_count` integer NOT NULL DEFAULT 0 CHECK (`unread_count` >= 0),
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connection_id`) REFERENCES `twilio_connections`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE UNIQUE INDEX `sms_threads_workspace_phone_unique`
  ON `sms_threads` (`workspace_id`,`participant_phone`);
CREATE INDEX `sms_threads_workspace_recent_idx`
  ON `sms_threads` (`workspace_id`,`last_message_at`,`id`);
CREATE INDEX `sms_threads_workspace_contact_idx`
  ON `sms_threads` (`workspace_id`,`contact_id`,`last_message_at`);

CREATE TABLE `sms_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `contact_id` text,
  `direction` text NOT NULL CHECK (`direction` IN ('inbound','outbound')),
  `provider_message_sid` text,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `from_phone` text NOT NULL,
  `to_phone` text NOT NULL,
  `body_template` text,
  `body_text` text NOT NULL,
  `purpose` text NOT NULL CHECK (`purpose` IN ('inbound','transactional','marketing')),
  `status` text NOT NULL CHECK (`status` IN ('received','pending','accepted','queued','sending','sent','delivered','undelivered','failed','unknown')),
  `error_code` text,
  `error` text,
  `opt_out_type` text CHECK (`opt_out_type` IN ('STOP','START','HELP')),
  `provider_status_at` text,
  `sent_by` text,
  `occurred_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connection_id`) REFERENCES `twilio_connections`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`thread_id`) REFERENCES `sms_threads`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE UNIQUE INDEX `sms_messages_workspace_idempotency_unique`
  ON `sms_messages` (`workspace_id`,`idempotency_key`);
CREATE UNIQUE INDEX `sms_messages_workspace_provider_unique`
  ON `sms_messages` (`workspace_id`,`provider_message_sid`) WHERE `provider_message_sid` IS NOT NULL;
CREATE INDEX `sms_messages_thread_occurred_idx`
  ON `sms_messages` (`workspace_id`,`thread_id`,`occurred_at`,`id`);
CREATE INDEX `sms_messages_workspace_status_idx`
  ON `sms_messages` (`workspace_id`,`status`,`updated_at`,`id`);

CREATE TABLE `twilio_webhook_receipts` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `event_type` text NOT NULL CHECK (`event_type` IN ('inbound','status')),
  `request_hash` text NOT NULL,
  `signature_hash` text NOT NULL,
  `provider_message_sid` text,
  `processed_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connection_id`) REFERENCES `twilio_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `twilio_webhook_receipts_connection_request_unique`
  ON `twilio_webhook_receipts` (`connection_id`,`request_hash`);
CREATE INDEX `twilio_webhook_receipts_workspace_processed_idx`
  ON `twilio_webhook_receipts` (`workspace_id`,`processed_at`,`id`);
