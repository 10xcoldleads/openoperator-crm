CREATE TABLE `marketing_campaigns` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','ready','sending','completed','cancelled')),
  `subject` text NOT NULL,
  `body_text` text NOT NULL,
  `contact_ids` text NOT NULL DEFAULT '[]',
  `published_version_id` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `marketing_campaigns_workspace_updated_idx`
  ON `marketing_campaigns` (`workspace_id`,`updated_at`,`id`);

CREATE TABLE `marketing_campaign_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `campaign_id` text NOT NULL,
  `version` integer NOT NULL,
  `subject` text NOT NULL,
  `body_text` text NOT NULL,
  `selected_contact_ids` text NOT NULL,
  `exclusion_summary` text NOT NULL,
  `published_by` text NOT NULL,
  `published_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`campaign_id`) REFERENCES `marketing_campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `marketing_campaign_versions_campaign_version_unique`
  ON `marketing_campaign_versions` (`workspace_id`,`campaign_id`,`version`);

CREATE TABLE `marketing_campaign_recipients` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `campaign_id` text NOT NULL,
  `campaign_version_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `email` text NOT NULL,
  `first_name` text,
  `last_name` text,
  `consent_revision` integer NOT NULL,
  `unsubscribe_token_hash` text NOT NULL,
  `status` text NOT NULL DEFAULT 'queued' CHECK (`status` IN ('queued','sending','succeeded','failed','suppressed','cancelled')),
  `attempt_count` integer NOT NULL DEFAULT 0,
  `provider_email_id` text,
  `response_status` integer,
  `error` text,
  `sent_at` text,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`campaign_id`) REFERENCES `marketing_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`campaign_version_id`) REFERENCES `marketing_campaign_versions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `marketing_campaign_recipients_version_contact_unique`
  ON `marketing_campaign_recipients` (`workspace_id`,`campaign_version_id`,`contact_id`);
CREATE UNIQUE INDEX `marketing_campaign_recipients_unsubscribe_hash_unique`
  ON `marketing_campaign_recipients` (`unsubscribe_token_hash`);
CREATE INDEX `marketing_campaign_recipients_campaign_status_idx`
  ON `marketing_campaign_recipients` (`workspace_id`,`campaign_id`,`status`,`id`);

CREATE TRIGGER `marketing_campaign_versions_immutable_update` BEFORE UPDATE ON `marketing_campaign_versions`
BEGIN SELECT RAISE(ABORT,'published marketing campaign versions are immutable'); END;

CREATE TRIGGER `marketing_campaign_recipients_identity_immutable` BEFORE UPDATE OF
  `workspace_id`,`campaign_id`,`campaign_version_id`,`contact_id`,`email`,`first_name`,`last_name`,`consent_revision`,`unsubscribe_token_hash`
  ON `marketing_campaign_recipients`
BEGIN SELECT RAISE(ABORT,'marketing recipient identity is immutable'); END;
