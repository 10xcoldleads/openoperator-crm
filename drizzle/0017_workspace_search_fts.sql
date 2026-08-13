CREATE VIRTUAL TABLE `crm_search_index` USING fts5(
  `workspace_id` UNINDEXED,
  `object_type` UNINDEXED,
  `record_id` UNINDEXED,
  `title`,
  `subtitle`,
  `keywords`,
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
SELECT `workspace_id`,'contact',`id`,
  trim(COALESCE(`first_name`,'') || ' ' || COALESCE(`last_name`,'')),
  `email`,
  trim(COALESCE(`company`,'') || ' ' || COALESCE(`owner`,'') || ' ' || `stage` || ' ' || `status`)
FROM `contacts`;

INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
SELECT `workspace_id`,'company',`id`,`name`,
  COALESCE(`domain`,''),
  trim(COALESCE(`industry`,'') || ' ' || COALESCE(`owner`,''))
FROM `companies`;

INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
SELECT o.`workspace_id`,'opportunity',o.`id`,o.`name`,
  c.`email`,
  trim(COALESCE(c.`first_name`,'') || ' ' || COALESCE(c.`last_name`,'') || ' ' ||
    COALESCE(co.`name`,c.`company`,'') || ' ' || COALESCE(o.`owner`,'') || ' ' || COALESCE(s.`name`,''))
FROM `opportunities` o
JOIN `contacts` c ON c.`workspace_id`=o.`workspace_id` AND c.`id`=o.`contact_id`
JOIN `pipeline_stages` s ON s.`workspace_id`=o.`workspace_id` AND s.`id`=o.`stage_id`
LEFT JOIN `companies` co ON co.`workspace_id`=c.`workspace_id` AND co.`id`=c.`company_id`;

CREATE TRIGGER `crm_search_contacts_insert`
AFTER INSERT ON `contacts`
BEGIN
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  VALUES (
    NEW.`workspace_id`,'contact',NEW.`id`,
    trim(COALESCE(NEW.`first_name`,'') || ' ' || COALESCE(NEW.`last_name`,'')),
    NEW.`email`,
    trim(COALESCE(NEW.`company`,'') || ' ' || COALESCE(NEW.`owner`,'') || ' ' || NEW.`stage` || ' ' || NEW.`status`)
  );
END;

CREATE TRIGGER `crm_search_contacts_update`
AFTER UPDATE OF `email`,`first_name`,`last_name`,`company`,`company_id`,`owner`,`stage`,`status` ON `contacts`
BEGIN
  DELETE FROM `crm_search_index` WHERE `workspace_id`=OLD.`workspace_id` AND `object_type`='contact' AND `record_id`=OLD.`id`;
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  VALUES (
    NEW.`workspace_id`,'contact',NEW.`id`,
    trim(COALESCE(NEW.`first_name`,'') || ' ' || COALESCE(NEW.`last_name`,'')),
    NEW.`email`,
    trim(COALESCE(NEW.`company`,'') || ' ' || COALESCE(NEW.`owner`,'') || ' ' || NEW.`stage` || ' ' || NEW.`status`)
  );
  DELETE FROM `crm_search_index`
    WHERE `workspace_id`=NEW.`workspace_id` AND `object_type`='opportunity'
      AND `record_id` IN (
        SELECT `id` FROM `opportunities` WHERE `workspace_id`=NEW.`workspace_id` AND `contact_id`=NEW.`id`
      );
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  SELECT o.`workspace_id`,'opportunity',o.`id`,o.`name`,NEW.`email`,
    trim(COALESCE(NEW.`first_name`,'') || ' ' || COALESCE(NEW.`last_name`,'') || ' ' ||
      COALESCE(co.`name`,NEW.`company`,'') || ' ' || COALESCE(o.`owner`,'') || ' ' || COALESCE(s.`name`,''))
  FROM `opportunities` o
  JOIN `pipeline_stages` s ON s.`workspace_id`=o.`workspace_id` AND s.`id`=o.`stage_id`
  LEFT JOIN `companies` co ON co.`workspace_id`=NEW.`workspace_id` AND co.`id`=NEW.`company_id`
  WHERE o.`workspace_id`=NEW.`workspace_id` AND o.`contact_id`=NEW.`id`;
END;

CREATE TRIGGER `crm_search_contacts_delete`
AFTER DELETE ON `contacts`
BEGIN
  DELETE FROM `crm_search_index` WHERE `workspace_id`=OLD.`workspace_id` AND `object_type`='contact' AND `record_id`=OLD.`id`;
END;

CREATE TRIGGER `crm_search_companies_insert`
AFTER INSERT ON `companies`
BEGIN
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  VALUES (
    NEW.`workspace_id`,'company',NEW.`id`,NEW.`name`,COALESCE(NEW.`domain`,''),
    trim(COALESCE(NEW.`industry`,'') || ' ' || COALESCE(NEW.`owner`,''))
  );
END;

CREATE TRIGGER `crm_search_companies_update`
AFTER UPDATE OF `name`,`domain`,`industry`,`owner` ON `companies`
BEGIN
  DELETE FROM `crm_search_index` WHERE `workspace_id`=OLD.`workspace_id` AND `object_type`='company' AND `record_id`=OLD.`id`;
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  VALUES (
    NEW.`workspace_id`,'company',NEW.`id`,NEW.`name`,COALESCE(NEW.`domain`,''),
    trim(COALESCE(NEW.`industry`,'') || ' ' || COALESCE(NEW.`owner`,''))
  );
  DELETE FROM `crm_search_index`
    WHERE `workspace_id`=NEW.`workspace_id` AND `object_type`='opportunity'
      AND `record_id` IN (
        SELECT o.`id` FROM `opportunities` o
        JOIN `contacts` c ON c.`workspace_id`=o.`workspace_id` AND c.`id`=o.`contact_id`
        WHERE o.`workspace_id`=NEW.`workspace_id` AND c.`company_id`=NEW.`id`
      );
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  SELECT o.`workspace_id`,'opportunity',o.`id`,o.`name`,c.`email`,
    trim(COALESCE(c.`first_name`,'') || ' ' || COALESCE(c.`last_name`,'') || ' ' ||
      NEW.`name` || ' ' || COALESCE(o.`owner`,'') || ' ' || COALESCE(s.`name`,''))
  FROM `opportunities` o
  JOIN `contacts` c ON c.`workspace_id`=o.`workspace_id` AND c.`id`=o.`contact_id`
  JOIN `pipeline_stages` s ON s.`workspace_id`=o.`workspace_id` AND s.`id`=o.`stage_id`
  WHERE o.`workspace_id`=NEW.`workspace_id` AND c.`company_id`=NEW.`id`;
END;

CREATE TRIGGER `crm_search_companies_delete`
AFTER DELETE ON `companies`
BEGIN
  DELETE FROM `crm_search_index` WHERE `workspace_id`=OLD.`workspace_id` AND `object_type`='company' AND `record_id`=OLD.`id`;
END;

CREATE TRIGGER `crm_search_opportunities_insert`
AFTER INSERT ON `opportunities`
BEGIN
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  SELECT NEW.`workspace_id`,'opportunity',NEW.`id`,NEW.`name`,c.`email`,
    trim(COALESCE(c.`first_name`,'') || ' ' || COALESCE(c.`last_name`,'') || ' ' ||
      COALESCE(co.`name`,c.`company`,'') || ' ' || COALESCE(NEW.`owner`,'') || ' ' || COALESCE(s.`name`,''))
  FROM `contacts` c
  JOIN `pipeline_stages` s ON s.`workspace_id`=NEW.`workspace_id` AND s.`id`=NEW.`stage_id`
  LEFT JOIN `companies` co ON co.`workspace_id`=c.`workspace_id` AND co.`id`=c.`company_id`
  WHERE c.`workspace_id`=NEW.`workspace_id` AND c.`id`=NEW.`contact_id`;
END;

CREATE TRIGGER `crm_search_opportunities_update`
AFTER UPDATE OF `name`,`contact_id`,`stage_id`,`owner` ON `opportunities`
BEGIN
  DELETE FROM `crm_search_index` WHERE `workspace_id`=OLD.`workspace_id` AND `object_type`='opportunity' AND `record_id`=OLD.`id`;
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  SELECT NEW.`workspace_id`,'opportunity',NEW.`id`,NEW.`name`,c.`email`,
    trim(COALESCE(c.`first_name`,'') || ' ' || COALESCE(c.`last_name`,'') || ' ' ||
      COALESCE(co.`name`,c.`company`,'') || ' ' || COALESCE(NEW.`owner`,'') || ' ' || COALESCE(s.`name`,''))
  FROM `contacts` c
  JOIN `pipeline_stages` s ON s.`workspace_id`=NEW.`workspace_id` AND s.`id`=NEW.`stage_id`
  LEFT JOIN `companies` co ON co.`workspace_id`=c.`workspace_id` AND co.`id`=c.`company_id`
  WHERE c.`workspace_id`=NEW.`workspace_id` AND c.`id`=NEW.`contact_id`;
END;

CREATE TRIGGER `crm_search_opportunities_delete`
AFTER DELETE ON `opportunities`
BEGIN
  DELETE FROM `crm_search_index` WHERE `workspace_id`=OLD.`workspace_id` AND `object_type`='opportunity' AND `record_id`=OLD.`id`;
END;

CREATE TRIGGER `crm_search_pipeline_stages_update`
AFTER UPDATE OF `name` ON `pipeline_stages`
BEGIN
  DELETE FROM `crm_search_index`
    WHERE `workspace_id`=NEW.`workspace_id` AND `object_type`='opportunity'
      AND `record_id` IN (
        SELECT `id` FROM `opportunities` WHERE `workspace_id`=NEW.`workspace_id` AND `stage_id`=NEW.`id`
      );
  INSERT INTO `crm_search_index` (`workspace_id`,`object_type`,`record_id`,`title`,`subtitle`,`keywords`)
  SELECT o.`workspace_id`,'opportunity',o.`id`,o.`name`,c.`email`,
    trim(COALESCE(c.`first_name`,'') || ' ' || COALESCE(c.`last_name`,'') || ' ' ||
      COALESCE(co.`name`,c.`company`,'') || ' ' || COALESCE(o.`owner`,'') || ' ' || NEW.`name`)
  FROM `opportunities` o
  JOIN `contacts` c ON c.`workspace_id`=o.`workspace_id` AND c.`id`=o.`contact_id`
  LEFT JOIN `companies` co ON co.`workspace_id`=c.`workspace_id` AND co.`id`=c.`company_id`
  WHERE o.`workspace_id`=NEW.`workspace_id` AND o.`stage_id`=NEW.`id`;
END;
