CREATE INDEX `visitor_profiles_workspace_domain_intent_idx`
  ON `visitor_profiles` (`workspace_id`,LOWER(TRIM(`company_domain`)),`last_seen_at`,`id`)
  WHERE `company_domain` IS NOT NULL AND TRIM(`company_domain`) <> '';
--> statement-breakpoint
CREATE INDEX `companies_workspace_domain_idx`
  ON `companies` (`workspace_id`,LOWER(TRIM(`domain`)),`id`)
  WHERE `domain` IS NOT NULL AND TRIM(`domain`) <> '';
