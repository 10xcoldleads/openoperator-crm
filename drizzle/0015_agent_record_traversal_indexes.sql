CREATE INDEX `companies_workspace_cursor_idx` ON `companies` (`workspace_id`,`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `contacts_workspace_cursor_idx` ON `contacts` (`workspace_id`,`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `opportunities_workspace_cursor_idx` ON `opportunities` (`workspace_id`,`updated_at`,`id`);
