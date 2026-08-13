CREATE TABLE `visitor_intent_cases` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `company_domain` text NOT NULL,
  `company_name` text NOT NULL,
  `status` text NOT NULL DEFAULT 'new'
    CHECK (`status` IN ('new','in_review','resolved','dismissed')),
  `priority` text NOT NULL DEFAULT 'normal'
    CHECK (`priority` IN ('low','normal','high','urgent')),
  `owner` text,
  `due_at` text,
  `evidence_updated_at` text NOT NULL,
  `intent_score` integer NOT NULL CHECK (`intent_score` BETWEEN 0 AND 100),
  `evidence_snapshot` text NOT NULL,
  `resolution_note` text,
  `revision` integer NOT NULL DEFAULT 1,
  `change_id` text,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visitor_intent_cases_active_domain_unique`
  ON `visitor_intent_cases` (`workspace_id`,`company_domain`)
  WHERE `status` IN ('new','in_review');
--> statement-breakpoint
CREATE INDEX `visitor_intent_cases_workspace_status_due_idx`
  ON `visitor_intent_cases` (`workspace_id`,`status`,`due_at`,`updated_at`,`id`);
