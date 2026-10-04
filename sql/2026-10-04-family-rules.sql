-- Existing production only. Run as the same owner, BEFORE deploying the new app.
-- No tables, ledger data, accounts, sessions, RLS policies or grants are changed.
-- Guarded against drift; exact repeats are a verified no-op. Do not run setup.sql.
begin;
select pg_advisory_xact_lock(hashtextextended('pisteborssi-rules-validation-migration', 0));
do $migration$
declare
  v_oid oid := to_regprocedure('public.pb_validate_state(jsonb)');
  v_hash text;
  v_owner oid;
  v_acl aclitem[];
  v_config text[];
  v_security boolean;
begin
  if v_oid is null then raise exception 'PB_RULES_MIGRATION_MISSING_BASELINE'; end if;
  select md5(pg_get_functiondef(p.oid)), p.proowner, p.proacl, p.proconfig, p.prosecdef
    into v_hash, v_owner, v_acl, v_config, v_security from pg_proc p where p.oid=v_oid;
  if v_acl::text is distinct from '{postgres=X/postgres}'
    or v_config is distinct from array['search_path=pg_catalog, public, pg_temp']::text[]
    or v_security is distinct from true then
    raise exception 'PB_RULES_MIGRATION_BASELINE_PERMISSIONS_CHANGED';
  end if;
  if v_hash = 'a53071b23e8a46bbd3d8f4ca19d0b9c7' then
    raise notice 'PB_RULES_MIGRATION_ALREADY_APPLIED';
    return;
  end if;
  if v_hash is distinct from 'bb796c3e1a2e6c8b7d70612395d75acf' then
    raise exception 'PB_RULES_MIGRATION_BASELINE_CHANGED';
  end if;
  if v_owner <> (select oid from pg_roles where rolname=current_user) then
    raise exception 'PB_RULES_MIGRATION_OWNER_REQUIRED';
  end if;
  execute $definition$
CREATE OR REPLACE FUNCTION public.pb_validate_state(p_state jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare v_person jsonb; v_entry jsonb; v_rule jsonb; v_rule_revision jsonb;
begin
  if jsonb_typeof(p_state) is distinct from 'object'
    or p_state->>'app' is distinct from 'pisteborssi'
    or p_state->>'version' is distinct from '4'
    or jsonb_typeof(p_state->'people') is distinct from 'array'
    or jsonb_typeof(p_state->'entries') is distinct from 'array' then
    raise exception 'PB_INVALID_STATE';
  end if;
  if jsonb_array_length(p_state->'people') > 200
    or jsonb_array_length(p_state->'entries') > 20000
    or octet_length(p_state::text) > 8388608 then raise exception 'PB_INVALID_STATE'; end if;
  if (select count(*) <> count(distinct p->>'id') from jsonb_array_elements(p_state->'people') p)
    or (select count(*) <> count(distinct e->>'id') from jsonb_array_elements(p_state->'entries') e)
    then raise exception 'PB_INVALID_STATE'; end if;
  for v_person in select value from jsonb_array_elements(p_state->'people') loop
    if jsonb_typeof(v_person) is distinct from 'object'
      or coalesce(v_person->>'id', '') !~ '^[a-zA-Z0-9_-]{1,100}$'
      or coalesce(v_person->>'role', '') not in ('parent', 'child')
      or length(btrim(coalesce(v_person->>'name', ''))) not between 1 and 80
      or jsonb_typeof(v_person->'archived') is distinct from 'boolean'
      or (v_person - array['id','name','role','archived']) <> '{}'::jsonb
      then raise exception 'PB_INVALID_STATE'; end if;
  end loop;
  for v_entry in select value from jsonb_array_elements(p_state->'entries') loop
    if jsonb_typeof(v_entry) is distinct from 'object'
      or coalesce(v_entry->>'id', '') !~ '^[a-zA-Z0-9_-]{1,100}$'
      or coalesce(v_entry->>'kind', '') not in ('points', 'reward')
      or not exists (select 1 from jsonb_array_elements(p_state->'people') p
        where p->>'id' = v_entry->>'childId' and p->>'role' = 'child')
      or not exists (select 1 from jsonb_array_elements(p_state->'people') p
        where p->>'id' = v_entry->>'actorId')
      or jsonb_typeof(v_entry->'points') is distinct from 'number'
      or jsonb_typeof(v_entry->'createdAt') is distinct from 'string'
      or (v_entry - array['id','kind','childId','actorId','createdAt','points','topic','reason','amount','revisions','deletedAt','deletedBy']) <> '{}'::jsonb
      then raise exception 'PB_INVALID_STATE'; end if;
    if v_entry->>'kind' = 'reward' then
      if v_entry->>'points' is distinct from '-10' or v_entry->>'amount' is distinct from '5'
        or jsonb_typeof(v_entry->'amount') is distinct from 'number'
        then raise exception 'PB_INVALID_STATE'; end if;
    elsif coalesce(v_entry->>'points','') not in ('-2','-1','1','2')
      or coalesce(v_entry->>'topic','') not in ('walk','trash','dishwasher','laundry','cooking','cycling_training','other')
      or jsonb_typeof(v_entry->'reason') is distinct from 'string'
      or length(v_entry->>'reason') > 300
      or (v_entry->>'topic' = 'other' and length(btrim(v_entry->>'reason')) = 0)
      or (v_entry->>'topic' <> 'other' and v_entry->>'reason' <> '')
      or ((v_entry->>'points')::integer < 0 and
        (v_entry->>'topic' <> 'other' or length(btrim(v_entry->>'reason')) = 0))
      then raise exception 'PB_INVALID_STATE';
    end if;
  end loop;
  -- Optional for older V4 ledgers; no data rewrite is needed.
  if p_state ? 'rules' then
    if jsonb_typeof(p_state->'rules') is distinct from 'array' then raise exception 'PB_INVALID_STATE'; end if;
    if jsonb_array_length(p_state->'rules') > 100
      or (select count(*) <> count(distinct r->>'id') from jsonb_array_elements(p_state->'rules') r)
      then raise exception 'PB_INVALID_STATE'; end if;
    for v_rule in select value from jsonb_array_elements(p_state->'rules') loop
      if jsonb_typeof(v_rule) is distinct from 'object'
        or jsonb_typeof(v_rule->'id') is distinct from 'string'
        or coalesce(v_rule->>'id','') !~ '^[a-zA-Z0-9_-]{1,100}$'
        or jsonb_typeof(v_rule->'title') is distinct from 'string'
        or length(v_rule->>'title') > 120 or length(btrim(v_rule->>'title')) < 1 or (v_rule->>'title') ~ '^[[:space:]]*$'
        or jsonb_typeof(v_rule->'content') is distinct from 'string'
        or length(v_rule->>'content') > 4000 or length(btrim(v_rule->>'content')) < 1 or (v_rule->>'content') ~ '^[[:space:]]*$'
        or jsonb_typeof(v_rule->'createdBy') is distinct from 'string'
        or jsonb_typeof(v_rule->'updatedBy') is distinct from 'string'
        or not exists (select 1 from jsonb_array_elements(p_state->'people') p
          where p->>'id' = v_rule->>'createdBy' and p->>'role' = 'parent')
        or not exists (select 1 from jsonb_array_elements(p_state->'people') p
          where p->>'id' = v_rule->>'updatedBy' and p->>'role' = 'parent')
        or jsonb_typeof(v_rule->'createdAt') is distinct from 'string'
        or length(v_rule->>'createdAt') > 40 or coalesce(v_rule->>'createdAt','') !~ '^\d{4}-\d\d-\d\dT'
        or jsonb_typeof(v_rule->'updatedAt') is distinct from 'string'
        or length(v_rule->>'updatedAt') > 40 or coalesce(v_rule->>'updatedAt','') !~ '^\d{4}-\d\d-\d\dT'
        or (v_rule - array['id','title','content','createdAt','createdBy','updatedAt','updatedBy','revisions','deletedAt','deletedBy']) <> '{}'::jsonb
        then raise exception 'PB_INVALID_STATE'; end if;
      if (v_rule->>'updatedAt')::timestamptz < (v_rule->>'createdAt')::timestamptz then raise exception 'PB_INVALID_STATE'; end if;
      if v_rule ? 'revisions' then
        if jsonb_typeof(v_rule->'revisions') is distinct from 'array' then raise exception 'PB_INVALID_STATE'; end if;
        if jsonb_array_length(v_rule->'revisions') > 100 then raise exception 'PB_INVALID_STATE'; end if;
        for v_rule_revision in select value from jsonb_array_elements(v_rule->'revisions') loop
          if jsonb_typeof(v_rule_revision) is distinct from 'object'
            or (v_rule_revision - array['at','by','title','content']) <> '{}'::jsonb
            or jsonb_typeof(v_rule_revision->'title') is distinct from 'string'
            or length(v_rule_revision->>'title') > 120 or length(btrim(v_rule_revision->>'title')) < 1 or (v_rule_revision->>'title') ~ '^[[:space:]]*$'
            or jsonb_typeof(v_rule_revision->'content') is distinct from 'string'
            or length(v_rule_revision->>'content') > 4000 or length(btrim(v_rule_revision->>'content')) < 1 or (v_rule_revision->>'content') ~ '^[[:space:]]*$'
            or jsonb_typeof(v_rule_revision->'by') is distinct from 'string'
            or not exists (select 1 from jsonb_array_elements(p_state->'people') p
              where p->>'id' = v_rule_revision->>'by' and p->>'role' = 'parent')
            or jsonb_typeof(v_rule_revision->'at') is distinct from 'string'
            or length(v_rule_revision->>'at') > 40 or coalesce(v_rule_revision->>'at','') !~ '^\d{4}-\d\d-\d\dT'
            then raise exception 'PB_INVALID_STATE'; end if;
          perform (v_rule_revision->>'at')::timestamptz;
        end loop;
      end if;
      if (v_rule ? 'deletedAt') <> (v_rule ? 'deletedBy') then raise exception 'PB_INVALID_STATE'; end if;
      if v_rule ? 'deletedAt' then
        if jsonb_typeof(v_rule->'deletedAt') is distinct from 'string'
          or length(v_rule->>'deletedAt') > 40 or coalesce(v_rule->>'deletedAt','') !~ '^\d{4}-\d\d-\d\dT'
          or jsonb_typeof(v_rule->'deletedBy') is distinct from 'string'
          or not exists (select 1 from jsonb_array_elements(p_state->'people') p
            where p->>'id' = v_rule->>'deletedBy' and p->>'role' = 'parent')
          then raise exception 'PB_INVALID_STATE'; end if;
        if (v_rule->>'deletedAt')::timestamptz < (v_rule->>'createdAt')::timestamptz then raise exception 'PB_INVALID_STATE'; end if;
      end if;
    end loop;
  end if;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception 'PB_INVALID_STATE';
end $function$;
$definition$;
  if (select md5(pg_get_functiondef(v_oid))) is distinct from 'a53071b23e8a46bbd3d8f4ca19d0b9c7' then
    raise exception 'PB_RULES_MIGRATION_RESULT_MISMATCH';
  end if;
  if exists (select 1 from pg_proc p where p.oid=v_oid and
    (p.proowner <> v_owner or p.proacl is distinct from v_acl or p.proconfig is distinct from v_config or p.prosecdef is distinct from v_security)) then
    raise exception 'PB_RULES_MIGRATION_PRIVILEGES_CHANGED';
  end if;
end $migration$;
commit;
