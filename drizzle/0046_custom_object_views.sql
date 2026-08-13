CREATE TABLE custom_object_views (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES custom_object_definitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','workspace')),
  filters TEXT NOT NULL DEFAULT '[]',
  visible_fields TEXT NOT NULL DEFAULT '[]',
  sort_field TEXT NOT NULL DEFAULT 'display_name',
  sort_direction TEXT NOT NULL DEFAULT 'asc' CHECK(sort_direction IN ('asc','desc')),
  revision INTEGER NOT NULL DEFAULT 1,
  change_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id,object_id,name)
);
--> statement-breakpoint
CREATE INDEX custom_object_views_workspace_object_visibility_idx
  ON custom_object_views(workspace_id,object_id,visibility,created_by,updated_at DESC,id DESC);
