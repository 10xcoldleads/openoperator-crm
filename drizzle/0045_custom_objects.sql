CREATE TABLE custom_object_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  singular_label TEXT NOT NULL,
  plural_label TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  change_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id,slug)
);
--> statement-breakpoint
CREATE INDEX custom_object_definitions_workspace_active_idx
  ON custom_object_definitions(workspace_id,active,plural_label,id);
--> statement-breakpoint
CREATE TABLE custom_object_records (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES custom_object_definitions(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  change_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX custom_object_records_workspace_object_updated_idx
  ON custom_object_records(workspace_id,object_id,updated_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE custom_object_relations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL REFERENCES custom_object_records(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('contact','company','opportunity','custom_record')),
  target_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id,source_record_id,target_type,target_id,label)
);
--> statement-breakpoint
CREATE INDEX custom_object_relations_workspace_source_idx
  ON custom_object_relations(workspace_id,source_record_id,created_at,id);
