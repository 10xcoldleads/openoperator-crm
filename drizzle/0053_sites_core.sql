CREATE TABLE `sites` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','published','revoked')),
  `pages` text NOT NULL,
  `theme` text NOT NULL,
  `custom_domain` text,
  `domain_status` text NOT NULL DEFAULT 'disabled' CHECK (`domain_status` IN ('disabled','verification_pending')),
  `published_version_id` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `sites_slug_unique` ON `sites` (`slug`);
CREATE INDEX `sites_workspace_updated_idx` ON `sites` (`workspace_id`,`updated_at`,`id`);

CREATE TABLE `site_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `site_id` text NOT NULL,
  `version` integer NOT NULL,
  `pages` text NOT NULL,
  `theme` text NOT NULL,
  `published_by` text NOT NULL,
  `published_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `site_versions_site_version_unique` ON `site_versions` (`workspace_id`,`site_id`,`version`);

CREATE TRIGGER `site_versions_immutable_update` BEFORE UPDATE ON `site_versions`
BEGIN SELECT RAISE(ABORT,'published site versions are immutable'); END;
