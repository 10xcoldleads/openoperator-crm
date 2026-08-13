ALTER TABLE `webhook_endpoints`
  ADD COLUMN `provider_credential_prefix` text;
--> statement-breakpoint
ALTER TABLE `webhook_endpoints`
  ADD COLUMN `provider_credential_ciphertext` text;
