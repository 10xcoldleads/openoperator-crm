CREATE TABLE object_page_layouts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('contact','company','opportunity')),
  name TEXT NOT NULL,
  sections TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  change_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, object_type),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX object_page_layouts_workspace_object_idx
  ON object_page_layouts(workspace_id, object_type);
