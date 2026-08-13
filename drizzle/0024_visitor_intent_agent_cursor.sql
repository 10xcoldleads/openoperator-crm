CREATE INDEX `visitor_profiles_workspace_updated_cursor_idx`
  ON `visitor_profiles` (`workspace_id`,`updated_at`,`id`);
