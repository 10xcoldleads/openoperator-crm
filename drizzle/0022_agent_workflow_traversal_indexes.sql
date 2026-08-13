CREATE INDEX `automation_rules_workspace_cursor_idx`
  ON `automation_rules` (`workspace_id`,`updated_at`,`id`);

CREATE INDEX `automation_runs_workspace_cursor_idx`
  ON `automation_runs` (`workspace_id`,`started_at`,`id`);
