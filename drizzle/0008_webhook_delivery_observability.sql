CREATE INDEX `webhook_delivery_retry_queue_idx`
ON `webhook_deliveries` (`direction`,`status`,`next_attempt_at`,`updated_at`);

CREATE INDEX `webhook_delivery_workspace_created_idx`
ON `webhook_deliveries` (`workspace_id`,`created_at`);
