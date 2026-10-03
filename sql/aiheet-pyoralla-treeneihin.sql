-- Existing installations: replace only the active topic whitelist; no ledger/account writes.
begin;
do $migration$
declare
  v_function regprocedure := 'public.pb_validate_state(jsonb)'::regprocedure;
  v_definition text;
  v_old constant text := $topics$('walk','trash','dishwasher','laundry','cooking','other')$topics$;
  v_new constant text := $topics$('walk','trash','dishwasher','laundry','cooking','cycling_training','other')$topics$;
  v_old_count integer;
  v_new_count integer;
  v_rule_count integer;
  v_before record;
begin
  select pg_get_functiondef(v_function) into v_definition;
  select proowner, proacl, prosecdef, proconfig into v_before
    from pg_catalog.pg_proc where oid = v_function;
  v_old_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
  v_new_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
  select count(*) into v_rule_count from regexp_matches(v_definition,
    $rule$coalesce[[:space:]]*\([[:space:]]*v_entry[[:space:]]*->>[[:space:]]*'topic'[[:space:]]*,[[:space:]]*''[[:space:]]*\)[[:space:]]+not[[:space:]]+in[[:space:]]*\($rule$, 'gi');
  if v_rule_count <> 1 then
    raise exception 'PB_TOPIC_MIGRATION_UNEXPECTED_DEFINITION';
  end if;
  if v_old_count = 1 and v_new_count = 0 and position(
    'coalesce(v_entry->>''topic'','''') not in ' || v_old in v_definition) > 0 then
    execute replace(v_definition, v_old, v_new);
  elsif v_old_count = 0 and v_new_count = 1 and position(
    'coalesce(v_entry->>''topic'','''') not in ' || v_new in v_definition) > 0 then
    null;
  else
    raise exception 'PB_TOPIC_MIGRATION_UNEXPECTED_DEFINITION';
  end if;
  if exists (select 1 from pg_catalog.pg_proc where oid = v_function and
    row(proowner, proacl, prosecdef, proconfig) is distinct from
    row(v_before.proowner, v_before.proacl, v_before.prosecdef, v_before.proconfig)) then
    raise exception 'PB_TOPIC_MIGRATION_ATTRIBUTES_CHANGED';
  end if;
end;
$migration$;
notify pgrst, 'reload schema';
commit;
