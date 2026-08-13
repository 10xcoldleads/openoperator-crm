CREATE TABLE `companies` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `name_key` text NOT NULL,
  `domain` text,
  `website` text,
  `industry` text,
  `owner` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_workspace_name_key_unique`
  ON `companies` (`workspace_id`,`name_key`);
--> statement-breakpoint
CREATE INDEX `companies_workspace_activity_idx`
  ON `companies` (`workspace_id`,`updated_at`);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_id` text REFERENCES `companies`(`id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `companies`
  (`id`,`workspace_id`,`name`,`name_key`,`created_at`,`updated_at`)
SELECT
  'cmp_' || lower(hex(randomblob(16))),
  `workspace_id`,
  MIN(TRIM(`company`)),
  LOWER(TRIM(`company`)),
  MIN(`created_at`),
  MAX(`updated_at`)
FROM `contacts`
WHERE `company` IS NOT NULL AND TRIM(`company`) <> ''
GROUP BY `workspace_id`,LOWER(TRIM(`company`));
--> statement-breakpoint
UPDATE `contacts`
SET `company_id` = (
  SELECT `companies`.`id`
  FROM `companies`
  WHERE `companies`.`workspace_id` = `contacts`.`workspace_id`
    AND `companies`.`name_key` = LOWER(TRIM(`contacts`.`company`))
)
WHERE `company` IS NOT NULL AND TRIM(`company`) <> '';
--> statement-breakpoint
CREATE INDEX `contacts_workspace_company_idx`
  ON `contacts` (`workspace_id`,`company_id`);
--> statement-breakpoint
CREATE TABLE `company_notes` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `company_id` text NOT NULL,
  `author` text NOT NULL,
  `body` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)
);
--> statement-breakpoint
CREATE INDEX `company_notes_company_idx`
  ON `company_notes` (`workspace_id`,`company_id`,`created_at`);
