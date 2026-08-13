CREATE TABLE `visitor_connectors` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `provider` text NOT NULL CHECK (`provider` IN ('audiencelab','rb2b')),
  `name` text NOT NULL,
  `token_hash` text NOT NULL,
  `token_prefix` text NOT NULL,
  `active` integer NOT NULL DEFAULT 1 CHECK (`active` IN (0,1)),
  `consent_default` text NOT NULL DEFAULT 'unknown'
    CHECK (`consent_default` IN ('unknown','granted','denied')),
  `created_by` text NOT NULL,
  `last_event_at` text,
  `change_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `visitor_connectors_token_hash_unique`
  ON `visitor_connectors` (`token_hash`);
CREATE UNIQUE INDEX `visitor_connectors_workspace_name_unique`
  ON `visitor_connectors` (`workspace_id`,`name`);

CREATE TABLE `visitor_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `connector_id` text NOT NULL,
  `provider` text NOT NULL CHECK (`provider` IN ('audiencelab','rb2b')),
  `identity_key` text NOT NULL,
  `identity_kind` text NOT NULL CHECK (`identity_kind` IN ('person','company')),
  `email` text,
  `first_name` text,
  `last_name` text,
  `linkedin_url` text,
  `title` text,
  `company_name` text,
  `company_domain` text,
  `industry` text,
  `employee_count` text,
  `estimated_revenue` text,
  `city` text,
  `region` text,
  `postal_code` text,
  `consent_status` text NOT NULL
    CHECK (`consent_status` IN ('unknown','granted','denied')),
  `review_status` text NOT NULL DEFAULT 'new'
    CHECK (`review_status` IN ('new','reviewed','promoted','suppressed')),
  `matched_contact_id` text,
  `visit_count` integer NOT NULL DEFAULT 0,
  `high_intent_count` integer NOT NULL DEFAULT 0,
  `first_seen_at` text NOT NULL,
  `last_seen_at` text NOT NULL,
  `latest_url` text,
  `latest_referrer` text,
  `tags` text NOT NULL DEFAULT '[]',
  `revision` integer NOT NULL DEFAULT 1,
  `review_change_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connector_id`) REFERENCES `visitor_connectors`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`matched_contact_id`) REFERENCES `contacts`(`id`) ON DELETE SET NULL
);
CREATE UNIQUE INDEX `visitor_profiles_connector_identity_unique`
  ON `visitor_profiles` (`connector_id`,`identity_key`);
CREATE INDEX `visitor_profiles_workspace_review_cursor_idx`
  ON `visitor_profiles` (`workspace_id`,`review_status`,`last_seen_at`,`id`);
CREATE INDEX `visitor_profiles_workspace_email_idx`
  ON `visitor_profiles` (`workspace_id`,`email`);

CREATE TABLE `visitor_events` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `connector_id` text NOT NULL,
  `profile_id` text NOT NULL,
  `provider` text NOT NULL CHECK (`provider` IN ('audiencelab','rb2b')),
  `dedupe_key` text NOT NULL,
  `ingest_nonce` text NOT NULL,
  `occurred_at` text NOT NULL,
  `captured_url` text,
  `referrer` text,
  `tags` text NOT NULL DEFAULT '[]',
  `is_repeat` integer NOT NULL DEFAULT 0 CHECK (`is_repeat` IN (0,1)),
  `is_high_intent` integer NOT NULL DEFAULT 0 CHECK (`is_high_intent` IN (0,1)),
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connector_id`) REFERENCES `visitor_connectors`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`profile_id`) REFERENCES `visitor_profiles`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `visitor_events_connector_dedupe_unique`
  ON `visitor_events` (`connector_id`,`dedupe_key`);
CREATE INDEX `visitor_events_profile_occurred_idx`
  ON `visitor_events` (`profile_id`,`occurred_at`,`id`);

-- A visitor profile is terminal once promoted. Enforce the corresponding
-- audit fact at the storage layer so racing promotion requests cannot record
-- duplicate successes even if their batches observe the winning row.
CREATE UNIQUE INDEX `audit_log_visitor_profile_promoted_once`
  ON `audit_log` (`workspace_id`,`entity_id`)
  WHERE `entity_type`='visitor_profile' AND `action`='visitor_profile.promoted';
