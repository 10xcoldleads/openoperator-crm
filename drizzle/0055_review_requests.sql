CREATE TABLE `review_destinations` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `name` text NOT NULL,
  `business_name` text NOT NULL,
  `review_url` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active' CHECK (`status` IN ('active','revoked')),
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `review_destinations_workspace_status_idx`
  ON `review_destinations` (`workspace_id`,`status`,`updated_at`,`id`);

CREATE TABLE `review_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `destination_id` text NOT NULL,
  `contact_id` text NOT NULL,
  `email` text NOT NULL,
  `first_name` text,
  `business_name` text NOT NULL,
  `review_url` text NOT NULL,
  `subject` text NOT NULL,
  `body_text` text NOT NULL,
  `feedback_token_hash` text NOT NULL,
  `unsubscribe_token_hash` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','sending','succeeded','failed')),
  `attempt_count` integer NOT NULL DEFAULT 0,
  `provider_email_id` text,
  `response_status` integer,
  `error` text,
  `sent_at` text,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`destination_id`) REFERENCES `review_destinations`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `review_requests_feedback_token_hash_unique` ON `review_requests` (`feedback_token_hash`);
CREATE UNIQUE INDEX `review_requests_unsubscribe_token_hash_unique` ON `review_requests` (`unsubscribe_token_hash`);
CREATE INDEX `review_requests_workspace_created_idx` ON `review_requests` (`workspace_id`,`created_at`,`id`);

CREATE TABLE `review_feedback` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `request_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `rating` integer NOT NULL CHECK (`rating` BETWEEN 1 AND 5),
  `feedback` text,
  `privacy_text` text NOT NULL,
  `ip_hash` text,
  `user_agent` text,
  `submitted_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`request_id`) REFERENCES `review_requests`(`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `review_feedback_request_unique` ON `review_feedback` (`workspace_id`,`request_id`);
CREATE UNIQUE INDEX `review_feedback_idempotency_unique` ON `review_feedback` (`workspace_id`,`idempotency_key`);

CREATE TRIGGER `review_requests_identity_immutable` BEFORE UPDATE OF
  `workspace_id`,`destination_id`,`contact_id`,`email`,`first_name`,`business_name`,`review_url`,`subject`,`body_text`,`feedback_token_hash`,`unsubscribe_token_hash`,`created_by`,`created_at`
  ON `review_requests`
BEGIN SELECT RAISE(ABORT,'review request identity is immutable'); END;

CREATE TRIGGER `review_feedback_immutable_update` BEFORE UPDATE ON `review_feedback`
BEGIN SELECT RAISE(ABORT,'review feedback is immutable'); END;
