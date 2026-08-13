CREATE TABLE `scheduler_requests` (
  `nonce` text PRIMARY KEY NOT NULL,
  `job` text NOT NULL,
  `requested_at` text NOT NULL,
  `created_at` text NOT NULL
);

CREATE INDEX `scheduler_requests_created_at_idx`
  ON `scheduler_requests` (`created_at`);
