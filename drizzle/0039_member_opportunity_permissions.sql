INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','read','',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','create','',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update','',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update_field','stage_id',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update_field','status',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update_field','value',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update_field','probability',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update_field','owner',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update_field','expected_close_at',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update_field','next_step',CURRENT_TIMESTAMP FROM workspace_access_policies;

INSERT OR IGNORE INTO workspace_role_grants
  (id,workspace_id,revision,role,resource,action,field_name,created_at)
SELECT 'grant_' || lower(hex(randomblob(16))),workspace_id,current_revision,
  'member','opportunity','update_field','lost_reason',CURRENT_TIMESTAMP FROM workspace_access_policies;

CREATE INDEX `workspace_role_grants_resource_lookup`
  ON `workspace_role_grants` (`workspace_id`,`revision`,`role`,`resource`,`action`,`field_name`);
