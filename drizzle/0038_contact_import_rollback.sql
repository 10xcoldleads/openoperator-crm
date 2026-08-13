CREATE TABLE `contact_imports` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `status` text DEFAULT 'committed' NOT NULL,
  `requested_rows` integer NOT NULL,
  `imported_rows` integer DEFAULT 0 NOT NULL,
  `skipped_rows` integer DEFAULT 0 NOT NULL,
  `rollback_deleted_rows` integer DEFAULT 0 NOT NULL,
  `rollback_conflict_rows` integer DEFAULT 0 NOT NULL,
  `rollback_missing_rows` integer DEFAULT 0 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `rolled_back_by` text,
  `rolled_back_at` text,
  `rollback_request_id` text,
  `rollback_audit_id` text,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `contact_imports_workspace_created_idx`
  ON `contact_imports` (`workspace_id`,`created_at`,`id`);

CREATE TABLE `contact_import_members` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `import_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `email` text NOT NULL,
  `imported_updated_at` text NOT NULL,
  `outcome` text DEFAULT 'created' NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`import_id`) REFERENCES `contact_imports`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX `contact_import_members_import_contact_unique`
  ON `contact_import_members` (`import_id`,`contact_id`);
CREATE INDEX `contact_import_members_workspace_contact_idx`
  ON `contact_import_members` (`workspace_id`,`contact_id`,`created_at`);

CREATE TRIGGER `contact_import_rollback`
AFTER UPDATE OF `status` ON `contact_imports`
WHEN OLD.status = 'committed' AND NEW.status = 'rolled_back'
BEGIN
  UPDATE contact_import_members
    SET outcome = 'missing'
    WHERE import_id = NEW.id
      AND workspace_id = NEW.workspace_id
      AND outcome = 'created'
      AND NOT EXISTS (
        SELECT 1 FROM contacts c
        WHERE c.workspace_id = NEW.workspace_id
          AND c.id = contact_import_members.contact_id
      );

  UPDATE contact_import_members
    SET outcome = 'conflict'
    WHERE import_id = NEW.id
      AND workspace_id = NEW.workspace_id
      AND outcome = 'created'
      AND EXISTS (
        SELECT 1 FROM contacts c
        WHERE c.workspace_id = NEW.workspace_id
          AND c.id = contact_import_members.contact_id
          AND (
            c.updated_at <> contact_import_members.imported_updated_at
            OR c.source_first <> 'csv_import'
            OR c.source_last <> 'csv_import'
            OR EXISTS (SELECT 1 FROM activities a WHERE a.workspace_id = NEW.workspace_id AND a.contact_id = c.id)
            OR EXISTS (SELECT 1 FROM deals d WHERE d.workspace_id = NEW.workspace_id AND d.contact_id = c.id)
            OR EXISTS (SELECT 1 FROM notes n WHERE n.workspace_id = NEW.workspace_id AND n.contact_id = c.id)
            OR EXISTS (SELECT 1 FROM opportunities o WHERE o.workspace_id = NEW.workspace_id AND o.contact_id = c.id)
            OR EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id = NEW.workspace_id AND t.contact_id = c.id)
            OR EXISTS (SELECT 1 FROM visitor_profiles v WHERE v.workspace_id = NEW.workspace_id AND v.matched_contact_id = c.id)
          )
      );

  DELETE FROM contacts
    WHERE workspace_id = NEW.workspace_id
      AND id IN (
        SELECT contact_id FROM contact_import_members
        WHERE import_id = NEW.id
          AND workspace_id = NEW.workspace_id
          AND outcome = 'created'
      );

  UPDATE contact_import_members
    SET outcome = 'rolled_back'
    WHERE import_id = NEW.id
      AND workspace_id = NEW.workspace_id
      AND outcome = 'created';

  UPDATE contact_imports
    SET rollback_deleted_rows = (
          SELECT COUNT(*) FROM contact_import_members
          WHERE import_id = NEW.id AND outcome = 'rolled_back'
        ),
        rollback_conflict_rows = (
          SELECT COUNT(*) FROM contact_import_members
          WHERE import_id = NEW.id AND outcome = 'conflict'
        ),
        rollback_missing_rows = (
          SELECT COUNT(*) FROM contact_import_members
          WHERE import_id = NEW.id AND outcome = 'missing'
        )
    WHERE id = NEW.id AND workspace_id = NEW.workspace_id;

  INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,
     before_state,after_state,request_id,created_at)
  VALUES
    (NEW.rollback_audit_id,NEW.workspace_id,'user',NEW.rolled_back_by,
     'contacts.import_rolled_back','contact_import',NEW.id,
     json_object('status','committed','imported_rows',NEW.imported_rows),
     json_object(
       'status','rolled_back',
       'deleted_rows',(SELECT rollback_deleted_rows FROM contact_imports WHERE id=NEW.id),
       'conflict_rows',(SELECT rollback_conflict_rows FROM contact_imports WHERE id=NEW.id),
       'missing_rows',(SELECT rollback_missing_rows FROM contact_imports WHERE id=NEW.id)
     ),
     NEW.rollback_request_id,NEW.rolled_back_at);
END;
