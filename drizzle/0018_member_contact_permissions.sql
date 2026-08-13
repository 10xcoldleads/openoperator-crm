CREATE TABLE `workspace_access_policies` (
  `workspace_id` text PRIMARY KEY NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `current_revision` integer DEFAULT 1 NOT NULL,
  `updated_by` text NOT NULL,
  `updated_at` text NOT NULL
);

CREATE TABLE `workspace_access_policy_versions` (
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `revision` integer NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`workspace_id`,`revision`)
);

CREATE TABLE `workspace_role_grants` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `revision` integer NOT NULL,
  `role` text NOT NULL,
  `resource` text NOT NULL,
  `action` text NOT NULL,
  `field_name` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`,`revision`)
    REFERENCES `workspace_access_policy_versions`(`workspace_id`,`revision`) ON DELETE CASCADE
);

CREATE UNIQUE INDEX `workspace_role_grants_unique`
  ON `workspace_role_grants` (`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`);
CREATE INDEX `workspace_role_grants_lookup`
  ON `workspace_role_grants` (`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`);

INSERT INTO `workspace_access_policies` (`workspace_id`,`current_revision`,`updated_by`,`updated_at`)
SELECT `id`,1,'system:migration',CURRENT_TIMESTAMP FROM `workspaces`;

INSERT INTO `workspace_access_policy_versions` (`workspace_id`,`revision`,`created_by`,`created_at`)
SELECT `id`,1,'system:migration',CURRENT_TIMESTAMP FROM `workspaces`;

INSERT INTO `workspace_role_grants`
  (`id`,`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`,`created_at`)
SELECT 'grant_' || lower(hex(randomblob(16))),`id`,1,'member','contact','create','',CURRENT_TIMESTAMP
FROM `workspaces`;

INSERT INTO `workspace_role_grants`
  (`id`,`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`,`created_at`)
SELECT 'grant_' || lower(hex(randomblob(16))),`id`,1,'member','contact','note','',CURRENT_TIMESTAMP
FROM `workspaces`;

INSERT INTO `workspace_role_grants`
  (`id`,`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`,`created_at`)
SELECT 'grant_' || lower(hex(randomblob(16))),`id`,1,'member','contact','update','',CURRENT_TIMESTAMP
FROM `workspaces`;

INSERT INTO `workspace_role_grants`
  (`id`,`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`,`created_at`)
SELECT 'grant_' || lower(hex(randomblob(16))),`id`,1,'member','contact','update_field','stage',CURRENT_TIMESTAMP
FROM `workspaces`;

INSERT INTO `workspace_role_grants`
  (`id`,`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`,`created_at`)
SELECT 'grant_' || lower(hex(randomblob(16))),`id`,1,'member','contact','update_field','status',CURRENT_TIMESTAMP
FROM `workspaces`;

INSERT INTO `workspace_role_grants`
  (`id`,`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`,`created_at`)
SELECT 'grant_' || lower(hex(randomblob(16))),`id`,1,'member','contact','update_field','owner',CURRENT_TIMESTAMP
FROM `workspaces`;

INSERT INTO `workspace_role_grants`
  (`id`,`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`,`created_at`)
SELECT 'grant_' || lower(hex(randomblob(16))),`id`,1,'member','contact','update_field','next_follow_up_at',CURRENT_TIMESTAMP
FROM `workspaces`;
