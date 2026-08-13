CREATE INDEX `opportunities_workspace_close_idx`
  ON `opportunities` (`workspace_id`,`status`,`expected_close_at`,`id`);
