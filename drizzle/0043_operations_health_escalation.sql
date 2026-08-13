ALTER TABLE `operations_health_policies`
  ADD COLUMN `escalation_delays_minutes` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `operations_health_incidents`
  ADD COLUMN `escalation_delays_minutes` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `operations_health_incidents`
  ADD COLUMN `escalated_steps` text DEFAULT '[]' NOT NULL;
