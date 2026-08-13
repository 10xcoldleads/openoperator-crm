CREATE TABLE `surveys` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','published','revoked')),
  `title` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `questions` text NOT NULL,
  `success_message` text NOT NULL,
  `published_version_id` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `surveys_slug_unique` ON `surveys` (`slug`);
CREATE INDEX `surveys_workspace_updated_idx` ON `surveys` (`workspace_id`,`updated_at`,`id`);

CREATE TABLE `survey_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `survey_id` text NOT NULL,
  `version` integer NOT NULL,
  `title` text NOT NULL,
  `description` text NOT NULL,
  `questions` text NOT NULL,
  `success_message` text NOT NULL,
  `published_by` text NOT NULL,
  `published_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`survey_id`) REFERENCES `surveys`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `survey_versions_survey_version_unique` ON `survey_versions` (`workspace_id`,`survey_id`,`version`);

CREATE TABLE `survey_responses` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `survey_id` text NOT NULL,
  `survey_version_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `answers` text NOT NULL,
  `privacy_accepted` integer NOT NULL CHECK (`privacy_accepted` IN (0,1)),
  `started_at` text,
  `submitted_at` text NOT NULL,
  `duration_seconds` integer CHECK (`duration_seconds` IS NULL OR (`duration_seconds` >= 0 AND `duration_seconds` <= 86400)),
  `ip_hash` text,
  `user_agent` text,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`survey_id`) REFERENCES `surveys`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`survey_version_id`) REFERENCES `survey_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `survey_responses_survey_idempotency_unique`
  ON `survey_responses` (`workspace_id`,`survey_id`,`idempotency_key`);
CREATE INDEX `survey_responses_survey_recent_idx`
  ON `survey_responses` (`workspace_id`,`survey_id`,`submitted_at`,`id`);

CREATE TRIGGER `survey_versions_immutable_update` BEFORE UPDATE ON `survey_versions`
BEGIN SELECT RAISE(ABORT,'published survey versions are immutable'); END;
CREATE TRIGGER `survey_responses_immutable_update` BEFORE UPDATE ON `survey_responses`
BEGIN SELECT RAISE(ABORT,'survey responses are immutable'); END;
