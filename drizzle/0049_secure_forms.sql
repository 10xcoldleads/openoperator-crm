CREATE TABLE `forms` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','published','revoked')),
  `title` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `fields` text NOT NULL,
  `consent_text` text NOT NULL,
  `success_message` text NOT NULL,
  `published_version_id` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `forms_slug_unique` ON `forms` (`slug`);
CREATE INDEX `forms_workspace_updated_idx` ON `forms` (`workspace_id`,`updated_at`,`id`);

CREATE TABLE `form_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `form_id` text NOT NULL,
  `version` integer NOT NULL,
  `title` text NOT NULL,
  `description` text NOT NULL,
  `fields` text NOT NULL,
  `consent_text` text NOT NULL,
  `success_message` text NOT NULL,
  `published_by` text NOT NULL,
  `published_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `form_versions_form_version_unique` ON `form_versions` (`workspace_id`,`form_id`,`version`);

CREATE TABLE `form_submissions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `form_id` text NOT NULL,
  `form_version_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `contact_id` text NOT NULL,
  `payload` text NOT NULL,
  `email_consent` integer NOT NULL CHECK (`email_consent` IN (0,1)),
  `consent_text` text NOT NULL,
  `ip_hash` text,
  `user_agent` text,
  `submitted_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`form_version_id`) REFERENCES `form_versions`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `form_submissions_form_idempotency_unique`
  ON `form_submissions` (`workspace_id`,`form_id`,`idempotency_key`);
CREATE INDEX `form_submissions_form_recent_idx`
  ON `form_submissions` (`workspace_id`,`form_id`,`submitted_at`,`id`);
