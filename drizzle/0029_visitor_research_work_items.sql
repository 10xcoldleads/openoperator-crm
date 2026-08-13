ALTER TABLE `agent_work_items` ADD COLUMN `visitor_profile_id` text
  REFERENCES `visitor_profiles`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `agent_work_items` ADD COLUMN `work_item_type` text NOT NULL DEFAULT 'general';
--> statement-breakpoint
ALTER TABLE `agent_work_items` ADD COLUMN `evidence_revision` integer;
--> statement-breakpoint
ALTER TABLE `agent_work_items` ADD COLUMN `evidence_snapshot` text;
--> statement-breakpoint
CREATE INDEX `agent_work_items_visitor_profile_idx`
  ON `agent_work_items` (`workspace_id`,`visitor_profile_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_work_items_active_visitor_research_unique`
  ON `agent_work_items` (`workspace_id`,`visitor_profile_id`,`work_item_type`)
  WHERE `visitor_profile_id` IS NOT NULL AND `status` IN ('queued','claimed');
