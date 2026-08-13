ALTER TABLE `workspace_access_policies` ADD COLUMN `current_change_id` text;

UPDATE `workspace_access_policies`
SET `current_change_id`='policy_initial_' || `workspace_id`
WHERE `current_change_id` IS NULL;

ALTER TABLE `workspace_access_policy_versions` ADD COLUMN `change_id` text;

UPDATE `workspace_access_policy_versions`
SET `change_id`='policy_initial_' || `workspace_id`
WHERE `change_id` IS NULL AND `revision`=1;

CREATE UNIQUE INDEX `workspace_access_policy_versions_change_unique`
  ON `workspace_access_policy_versions` (`change_id`);
