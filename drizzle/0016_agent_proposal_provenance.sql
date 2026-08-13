ALTER TABLE `agent_proposals` ADD COLUMN `credential_id` text REFERENCES `agent_credentials`(`id`);
--> statement-breakpoint
UPDATE `agent_proposals`
SET `credential_id` = (
  SELECT `agent_requests`.`credential_id`
  FROM `agent_requests`
  WHERE `agent_requests`.`workspace_id` = `agent_proposals`.`workspace_id`
    AND `agent_requests`.`proposal_id` = `agent_proposals`.`id`
  ORDER BY `agent_requests`.`created_at` DESC
  LIMIT 1
)
WHERE `credential_id` IS NULL
  AND EXISTS (
    SELECT 1
    FROM `agent_requests`
    WHERE `agent_requests`.`workspace_id` = `agent_proposals`.`workspace_id`
      AND `agent_requests`.`proposal_id` = `agent_proposals`.`id`
  );
--> statement-breakpoint
UPDATE `agent_proposals`
SET `credential_id` = (
  SELECT `agent_work_items`.`claimed_by_credential_id`
  FROM `agent_work_items`
  WHERE `agent_work_items`.`workspace_id` = `agent_proposals`.`workspace_id`
    AND `agent_proposals`.`dedupe_key` = 'work:' || `agent_work_items`.`id`
  LIMIT 1
)
WHERE `credential_id` IS NULL
  AND `dedupe_key` LIKE 'work:%'
  AND EXISTS (
    SELECT 1
    FROM `agent_work_items`
    WHERE `agent_work_items`.`workspace_id` = `agent_proposals`.`workspace_id`
      AND `agent_proposals`.`dedupe_key` = 'work:' || `agent_work_items`.`id`
      AND `agent_work_items`.`claimed_by_credential_id` IS NOT NULL
  );
--> statement-breakpoint
CREATE INDEX `agent_proposals_credential_created_idx`
  ON `agent_proposals` (`workspace_id`,`credential_id`,`created_at`,`id`);
