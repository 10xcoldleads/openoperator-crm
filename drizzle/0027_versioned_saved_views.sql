ALTER TABLE `saved_views` ADD COLUMN `visibility` text NOT NULL DEFAULT 'private'
  CHECK (`visibility` IN ('private','workspace'));
--> statement-breakpoint
ALTER TABLE `saved_views` ADD COLUMN `columns` text NOT NULL DEFAULT '["identity","company","score","stage","owner"]';
--> statement-breakpoint
ALTER TABLE `saved_views` ADD COLUMN `sorts` text NOT NULL DEFAULT '[{"field":"recent","direction":"desc"}]';
--> statement-breakpoint
ALTER TABLE `saved_views` ADD COLUMN `revision` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `saved_views` ADD COLUMN `change_id` text;
--> statement-breakpoint
CREATE INDEX `saved_views_workspace_visibility_creator_idx`
  ON `saved_views` (`workspace_id`,`object_type`,`visibility`,`created_by`,`updated_at`);
