BEGIN;
DO $migration$
DECLARE
  definition text;
  old_literal CONSTANT text := '''12 hours 1 minute''';
  new_literal CONSTANT text := '''365 days 1 minute''';
  old_count integer;
  new_count integer;
BEGIN
  definition := pg_catalog.pg_get_functiondef('public.pb_commit(bigint,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb,text)'::regprocedure);
  old_count := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_literal, ''))) / pg_catalog.length(old_literal);
  new_count := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, new_literal, ''))) / pg_catalog.length(new_literal);
  IF old_count = 1 AND new_count = 0 THEN
    BEGIN
      EXECUTE pg_catalog.replace(definition, old_literal, new_literal);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PB_SESSION_CAP_MIGRATION_FAILED';
    END;
  ELSIF old_count = 0 AND new_count = 1 THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'PB_SESSION_CAP_MIGRATION_UNEXPECTED_DEFINITION';
  END IF;
END;
$migration$;
NOTIFY pgrst, 'reload schema';
COMMIT;
SELECT
  pg_catalog.strpos(definition, '''12 hours 1 minute''') > 0 AS active_pb_commit_12_hours_1_minute,
  pg_catalog.strpos(definition, '''365 days 1 minute''') > 0 AS active_pb_commit_365_days_1_minute,
  EXISTS (SELECT 1 FROM public.pb_ledger WHERE singleton) AS initialized_ready
FROM (SELECT pg_catalog.pg_get_functiondef('public.pb_commit(bigint,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb,text)'::regprocedure) AS definition) AS checked;
