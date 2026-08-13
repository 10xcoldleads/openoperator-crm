CREATE TABLE `booking_calendars` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft' CHECK (`status` IN ('draft','published','revoked')),
  `title` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `timezone` text NOT NULL,
  `duration_minutes` integer NOT NULL CHECK (`duration_minutes` BETWEEN 15 AND 180),
  `buffer_before_minutes` integer NOT NULL DEFAULT 0 CHECK (`buffer_before_minutes` BETWEEN 0 AND 120),
  `buffer_after_minutes` integer NOT NULL DEFAULT 0 CHECK (`buffer_after_minutes` BETWEEN 0 AND 120),
  `minimum_notice_minutes` integer NOT NULL DEFAULT 60 CHECK (`minimum_notice_minutes` BETWEEN 0 AND 43200),
  `maximum_days_ahead` integer NOT NULL DEFAULT 60 CHECK (`maximum_days_ahead` BETWEEN 1 AND 365),
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `booking_calendars_slug_unique` ON `booking_calendars` (`slug`);
CREATE INDEX `booking_calendars_workspace_updated_idx` ON `booking_calendars` (`workspace_id`,`updated_at`,`id`);

CREATE TABLE `booking_availability_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `calendar_id` text NOT NULL,
  `day_of_week` integer NOT NULL CHECK (`day_of_week` BETWEEN 0 AND 6),
  `start_minute` integer NOT NULL CHECK (`start_minute` BETWEEN 0 AND 1439),
  `end_minute` integer NOT NULL CHECK (`end_minute` BETWEEN 1 AND 1440),
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`calendar_id`) REFERENCES `booking_calendars`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`start_minute` < `end_minute`)
);
CREATE UNIQUE INDEX `booking_rules_calendar_day_window_unique`
  ON `booking_availability_rules` (`workspace_id`,`calendar_id`,`day_of_week`,`start_minute`,`end_minute`);
CREATE INDEX `booking_rules_calendar_day_idx` ON `booking_availability_rules` (`workspace_id`,`calendar_id`,`day_of_week`);

CREATE TABLE `booking_appointments` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `calendar_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `phone` text,
  `visitor_timezone` text NOT NULL,
  `starts_at` text NOT NULL,
  `ends_at` text NOT NULL,
  `status` text NOT NULL DEFAULT 'booked' CHECK (`status` IN ('booked','cancelled')),
  `manage_token_hash` text NOT NULL,
  `external_provider` text,
  `external_event_id` text,
  `sync_status` text NOT NULL DEFAULT 'local' CHECK (`sync_status` IN ('local','pending','synced','failed')),
  `cancelled_at` text,
  `cancellation_reason` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`calendar_id`) REFERENCES `booking_calendars`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `booking_appointments_calendar_idempotency_unique`
  ON `booking_appointments` (`workspace_id`,`calendar_id`,`idempotency_key`);
CREATE UNIQUE INDEX `booking_appointments_calendar_start_active_unique`
  ON `booking_appointments` (`workspace_id`,`calendar_id`,`starts_at`) WHERE `status`='booked';
CREATE UNIQUE INDEX `booking_appointments_manage_token_unique` ON `booking_appointments` (`manage_token_hash`);
CREATE INDEX `booking_appointments_calendar_range_idx`
  ON `booking_appointments` (`workspace_id`,`calendar_id`,`status`,`starts_at`,`ends_at`);
