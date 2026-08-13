CREATE TABLE `payment_ledger_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `contact_id` text,
  `opportunity_id` text,
  `parent_entry_id` text,
  `idempotency_key` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('payment','refund','dispute','dispute_reversal')),
  `amount_minor` integer NOT NULL CHECK (`amount_minor` > 0 AND `amount_minor` <= 9007199254740991),
  `currency` text NOT NULL CHECK (length(`currency`)=3 AND `currency`=upper(`currency`)),
  `description` text NOT NULL,
  `provider` text NOT NULL DEFAULT 'manual' CHECK (`provider` IN ('manual')),
  `provider_reference` text,
  `occurred_at` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`parent_entry_id`) REFERENCES `payment_ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict,
  CHECK ((`kind`='payment' AND `parent_entry_id` IS NULL) OR (`kind`<>'payment' AND `parent_entry_id` IS NOT NULL))
);
CREATE UNIQUE INDEX `payment_ledger_workspace_idempotency_unique`
  ON `payment_ledger_entries` (`workspace_id`,`idempotency_key`);
CREATE UNIQUE INDEX `payment_ledger_provider_reference_unique`
  ON `payment_ledger_entries` (`workspace_id`,`provider`,`provider_reference`) WHERE `provider_reference` IS NOT NULL;
CREATE INDEX `payment_ledger_workspace_occurred_idx`
  ON `payment_ledger_entries` (`workspace_id`,`occurred_at`,`id`);
CREATE INDEX `payment_ledger_parent_idx`
  ON `payment_ledger_entries` (`workspace_id`,`parent_entry_id`,`occurred_at`,`id`);
CREATE INDEX `payment_ledger_contact_idx`
  ON `payment_ledger_entries` (`workspace_id`,`contact_id`,`occurred_at`,`id`);

CREATE TRIGGER `payment_ledger_immutable_update`
BEFORE UPDATE ON `payment_ledger_entries`
BEGIN SELECT RAISE(ABORT,'payment ledger entries are immutable'); END;
