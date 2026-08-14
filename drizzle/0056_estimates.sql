CREATE TABLE `estimates` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `opportunity_id` text,
  `estimate_number` text NOT NULL,
  `title` text NOT NULL,
  `seller_name` text NOT NULL,
  `seller_email` text NOT NULL,
  `currency` text NOT NULL CHECK (length(`currency`)=3 AND `currency`=upper(`currency`)),
  `expires_on` text,
  `notes` text NOT NULL DEFAULT '',
  `line_items` text NOT NULL DEFAULT '[]' CHECK (json_valid(`line_items`)),
  `subtotal_minor` integer NOT NULL DEFAULT 0 CHECK (`subtotal_minor` >= 0 AND `subtotal_minor` <= 9007199254740991),
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','published','revoked')),
  `published_version_id` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `estimates_workspace_number_unique` ON `estimates` (`workspace_id`,`estimate_number`);
CREATE INDEX `estimates_workspace_status_idx` ON `estimates` (`workspace_id`,`status`,`updated_at`,`id`);
CREATE INDEX `estimates_contact_idx` ON `estimates` (`workspace_id`,`contact_id`,`updated_at`,`id`);

CREATE TABLE `estimate_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `estimate_id` text NOT NULL,
  `version` integer NOT NULL CHECK (`version` > 0),
  `estimate_number` text NOT NULL,
  `title` text NOT NULL,
  `seller_name` text NOT NULL,
  `seller_email` text NOT NULL,
  `recipient_name` text NOT NULL,
  `recipient_email` text NOT NULL,
  `currency` text NOT NULL CHECK (length(`currency`)=3 AND `currency`=upper(`currency`)),
  `expires_on` text,
  `notes` text NOT NULL,
  `line_items` text NOT NULL CHECK (json_valid(`line_items`)),
  `subtotal_minor` integer NOT NULL CHECK (`subtotal_minor` > 0 AND `subtotal_minor` <= 9007199254740991),
  `access_token_hash` text NOT NULL,
  `published_by` text NOT NULL,
  `published_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`estimate_id`) REFERENCES `estimates`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `estimate_versions_estimate_version_unique` ON `estimate_versions` (`workspace_id`,`estimate_id`,`version`);
CREATE UNIQUE INDEX `estimate_versions_access_hash_unique` ON `estimate_versions` (`access_token_hash`);

CREATE TABLE `estimate_responses` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `estimate_id` text NOT NULL,
  `version_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `decision` text NOT NULL CHECK (`decision` IN ('acknowledged','declined')),
  `typed_name` text NOT NULL,
  `note` text,
  `privacy_text` text NOT NULL,
  `ip_hash` text,
  `user_agent` text,
  `submitted_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`estimate_id`) REFERENCES `estimates`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`version_id`) REFERENCES `estimate_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `estimate_responses_version_unique` ON `estimate_responses` (`workspace_id`,`version_id`);
CREATE UNIQUE INDEX `estimate_responses_idempotency_unique` ON `estimate_responses` (`workspace_id`,`idempotency_key`);

CREATE TRIGGER `estimate_versions_immutable_update` BEFORE UPDATE ON `estimate_versions`
BEGIN SELECT RAISE(ABORT,'estimate versions are immutable'); END;
CREATE TRIGGER `estimate_responses_immutable_update` BEFORE UPDATE ON `estimate_responses`
BEGIN SELECT RAISE(ABORT,'estimate responses are immutable'); END;
