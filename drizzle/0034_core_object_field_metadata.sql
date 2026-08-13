CREATE TABLE custom_field_definitions_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('contact','company','opportunity')),
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text','number','boolean','date','select')),
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  change_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, object_type, field_key),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

INSERT INTO custom_field_definitions_v2
  (id,workspace_id,object_type,field_key,label,field_type,options,required,active,position,revision,change_id,created_by,created_at,updated_at)
SELECT id,workspace_id,object_type,field_key,label,field_type,options,required,active,position,revision,change_id,created_by,created_at,updated_at
FROM custom_field_definitions;

DROP TABLE custom_field_definitions;
ALTER TABLE custom_field_definitions_v2 RENAME TO custom_field_definitions;

CREATE INDEX custom_field_definitions_workspace_object_position_idx
  ON custom_field_definitions(workspace_id, object_type, active, position, id);

ALTER TABLE companies ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}';
ALTER TABLE opportunities ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}';
