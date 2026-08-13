CREATE INDEX IF NOT EXISTS `contacts_workspace_status_stage_idx`
ON `contacts` (`workspace_id`,`status`,`stage`);

CREATE INDEX IF NOT EXISTS `contacts_workspace_owner_idx`
ON `contacts` (`workspace_id`,`owner`);

CREATE INDEX IF NOT EXISTS `contacts_workspace_source_idx`
ON `contacts` (`workspace_id`,`source_last`);

CREATE INDEX IF NOT EXISTS `contacts_workspace_activity_idx`
ON `contacts` (`workspace_id`,`last_activity_at`);

CREATE INDEX IF NOT EXISTS `contacts_workspace_follow_up_idx`
ON `contacts` (`workspace_id`,`next_follow_up_at`);

CREATE INDEX IF NOT EXISTS `contacts_workspace_score_idx`
ON `contacts` (`workspace_id`,`score`);
