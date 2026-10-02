-- First install only: run in Supabase SQL Editor as owner. Vercel initializes accounts.
-- Existing installations with SQLSTATE 42702: run sql/korjaus-42702.sql instead of setup.
-- Only the Node backend/bootstrap may use the service-role-capable sb_secret_ key.
-- No anon/authenticated policy exists; SECURITY DEFINER RPCs are the only access path.
begin;

create table if not exists public.pb_ledger (
  singleton boolean primary key default true check (singleton),
  state jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  initialized_at timestamptz not null default now()
);
create table if not exists public.pb_accounts (
  person_id text primary key,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  credential jsonb not null
);
create table if not exists public.pb_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  person_id text not null references public.pb_accounts(person_id) on delete cascade,
  csrf_token text not null check (csrf_token ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz not null
);
create index if not exists pb_sessions_actor on public.pb_sessions(person_id);
create index if not exists pb_sessions_expiry on public.pb_sessions(expires_at);
create table if not exists public.pb_rate_buckets (
  bucket_hash text primary key check (bucket_hash ~ '^[a-f0-9]{64}$'),
  started_at timestamptz not null,
  count integer not null check (count > 0)
);
create index if not exists pb_rate_expiry on public.pb_rate_buckets(started_at);
create table if not exists public.pb_idempotency_results (
  scope text not null,
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (scope, key_hash)
);
create table if not exists public.pb_import_previews (
  id uuid primary key,
  actor_id text not null references public.pb_accounts(person_id),
  source_revision bigint not null,
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  imported jsonb not null,
  expires_at timestamptz not null,
  consumed boolean not null default false
);
create index if not exists pb_preview_expiry on public.pb_import_previews(expires_at);

alter table public.pb_ledger enable row level security;
alter table public.pb_accounts enable row level security;
alter table public.pb_sessions enable row level security;
alter table public.pb_rate_buckets enable row level security;
alter table public.pb_idempotency_results enable row level security;
alter table public.pb_import_previews enable row level security;
revoke all on public.pb_ledger, public.pb_accounts, public.pb_sessions,
  public.pb_rate_buckets, public.pb_idempotency_results, public.pb_import_previews
  from public, anon, authenticated, service_role;

create or replace function public.pb_validate_state(p_state jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_person jsonb; v_entry jsonb;
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
      or coalesce(v_entry->>'topic','') not in ('walk','trash','dishwasher','laundry','cooking','other')
      or jsonb_typeof(v_entry->'reason') is distinct from 'string'
      or length(v_entry->>'reason') > 300
      or (v_entry->>'topic' = 'other' and length(btrim(v_entry->>'reason')) = 0)
      or (v_entry->>'topic' <> 'other' and v_entry->>'reason' <> '')
      or ((v_entry->>'points')::integer < 0 and
        (v_entry->>'topic' <> 'other' or length(btrim(v_entry->>'reason')) = 0))
      then raise exception 'PB_INVALID_STATE';
    end if;
  end loop;
end $$;

create or replace function public.pb_validate_accounts(p_accounts jsonb, p_state jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare a jsonb; c jsonb;
begin
  if jsonb_typeof(p_accounts) is distinct from 'array' or jsonb_array_length(p_accounts) > 200
    then raise exception 'PB_INVALID_ACCOUNT'; end if;
  for a in select value from jsonb_array_elements(p_accounts) loop
    c := a->'credential';
    if not exists (select 1 from jsonb_array_elements(p_state->'people') p where p->>'id' = a->>'personId')
      or coalesce(a->>'username', '') !~ '^[a-z0-9][a-z0-9._-]{2,39}$'
      or c->>'algorithm' is distinct from 'scrypt'
      or c->>'N' is distinct from '32768' or c->>'r' is distinct from '8' or c->>'p' is distinct from '3'
      or coalesce(c->>'salt', '') !~ '^[a-f0-9]{64}$'
      or coalesce(c->>'hash', '') !~ '^[a-f0-9]{128}$'
      or jsonb_typeof(c->'mustChange') is distinct from 'boolean'
      then raise exception 'PB_INVALID_ACCOUNT'; end if;
  end loop;
end $$;

create or replace function public.pb_snapshot(p_session_hash text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare result jsonb;
begin
  -- One statement gives a single MVCC snapshot for ledger, accounts and session.
  select jsonb_build_object('ready', true, 'state', x.state, 'revision', x.revision,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
      'personId', a.person_id, 'username', a.username, 'credential', a.credential)
      order by a.person_id) from public.pb_accounts a), '[]'::jsonb),
    'session', (select jsonb_build_object('personId', s.person_id, 'csrfToken', s.csrf_token, 'expiresAt', s.expires_at)
      from public.pb_sessions s where s.token_hash = p_session_hash and s.expires_at > now())
  ) into result from public.pb_ledger x where x.singleton;
  return coalesce(result, jsonb_build_object('ready', false, 'revision', 0, 'accounts', '[]'::jsonb, 'session', null));
end $$;

create or replace function public.pb_idempotency(p_scope text, p_key_hash text, p_request_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare r public.pb_idempotency_results%rowtype;
begin
  select * into r from public.pb_idempotency_results
    where scope = p_scope and key_hash = p_key_hash;
  if not found then return null; end if;
  if r.request_hash <> p_request_hash then raise exception 'PB_IDEMPOTENCY_CONFLICT'; end if;
  return r.result;
end $$;

create or replace function public.pb_rate(p_buckets jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare b jsonb; n integer; w integer; lim integer; allowed boolean := true;
begin
  if jsonb_typeof(p_buckets) is distinct from 'array' or jsonb_array_length(p_buckets) not between 1 and 4
    then raise exception 'PB_INVALID_RATE'; end if;
  delete from public.pb_rate_buckets where started_at < now() - interval '1 day';
  for b in select value from jsonb_array_elements(p_buckets) order by value->>'key' loop
    w := (b->>'window')::integer; lim := (b->>'limit')::integer;
    if coalesce(b->>'key','') !~ '^[a-f0-9]{64}$' or w not in (60,900) or lim not between 1 and 200
      then raise exception 'PB_INVALID_RATE'; end if;
    insert into public.pb_rate_buckets(bucket_hash, started_at, count) values (b->>'key', now(), 1)
    on conflict (bucket_hash) do update set
      count = case when public.pb_rate_buckets.started_at + make_interval(secs => w) <= now() then 1
        else least(public.pb_rate_buckets.count + 1, 1000000) end,
      started_at = case when public.pb_rate_buckets.started_at + make_interval(secs => w) <= now()
        then now() else public.pb_rate_buckets.started_at end
    returning count into n;
    if n > lim then allowed := false; end if;
  end loop;
  return jsonb_build_object('allowed', allowed);
end $$;

create or replace function public.pb_preview(p_id text, p_actor_id text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare result jsonb;
begin
  select jsonb_build_object('id', id, 'actorId', actor_id, 'sourceRevision', source_revision,
    'sourceHash', source_hash, 'imported', imported, 'expiresAt', expires_at, 'consumed', consumed)
    into result from public.pb_import_previews
    where id::text = p_id and actor_id = p_actor_id and expires_at > now();
  return result;
end $$;

create or replace function public.pb_commit(
  p_expected_revision bigint, p_state jsonb, p_actor_id text, p_session_hash text,
  p_scope text, p_key_hash text, p_request_hash text, p_result jsonb,
  p_accounts jsonb, p_sessions jsonb, p_remove_sessions jsonb, p_revoke_actor text,
  p_preview jsonb, p_consume_preview text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare l public.pb_ledger%rowtype; cached jsonb; v_account jsonb; v_session jsonb;
begin
  select * into l from public.pb_ledger where singleton for update;
  if not found then raise exception 'PB_NOT_INITIALIZED'; end if;
  cached := public.pb_idempotency(p_scope, p_key_hash, p_request_hash);
  if cached is not null then return jsonb_build_object('committed', true, 'result', cached); end if;
  if l.revision <> p_expected_revision then return jsonb_build_object('committed', false); end if;
  if p_session_hash is not null and not exists (
    select 1 from public.pb_sessions as existing_session where existing_session.token_hash = p_session_hash
      and existing_session.person_id = p_actor_id and existing_session.expires_at > now()
  ) then raise exception 'PB_SESSION_INVALID'; end if;
  if not exists (select 1 from jsonb_array_elements(l.state->'people') p
    join public.pb_accounts as existing_account on existing_account.person_id = p->>'id'
    where p->>'id' = p_actor_id and p->'archived' = 'false'::jsonb) then raise exception 'PB_SESSION_INVALID'; end if;
  perform public.pb_validate_state(p_state);
  perform public.pb_validate_accounts(p_accounts, p_state);
  for v_account in select value from jsonb_array_elements(p_accounts) loop
    begin
      insert into public.pb_accounts(person_id, username, credential)
        values (v_account->>'personId', v_account->>'username', v_account->'credential')
      on conflict (person_id) do update set username = excluded.username, credential = excluded.credential;
    exception when unique_violation then raise exception 'PB_USERNAME_TAKEN'; end;
  end loop;
  if not exists (select 1 from jsonb_array_elements(p_state->'people') p
    join public.pb_accounts as existing_account on existing_account.person_id = p->>'id'
    where p->>'role' = 'parent' and p->'archived' = 'false'::jsonb) then raise exception 'PB_LAST_PARENT'; end if;
  if p_consume_preview is not null then
    update public.pb_import_previews set consumed = true
      where id::text = p_consume_preview and actor_id = p_actor_id and not consumed and expires_at > now();
    if not found then raise exception 'PB_PREVIEW_INVALID'; end if;
  end if;
  if p_preview is not null then
    if p_preview->>'actorId' is distinct from p_actor_id then raise exception 'PB_PREVIEW_INVALID'; end if;
    insert into public.pb_import_previews(id, actor_id, source_revision, source_hash, imported, expires_at)
      values ((p_preview->>'id')::uuid, p_actor_id, (p_preview->>'sourceRevision')::bigint,
        p_preview->>'sourceHash', p_preview->'imported', (p_preview->>'expiresAt')::timestamptz);
  end if;
  delete from public.pb_sessions where expires_at <= now() or person_id = p_revoke_actor
    or token_hash in (select jsonb_array_elements_text(p_remove_sessions));
  for v_session in select value from jsonb_array_elements(p_sessions) loop
    if (v_session->>'expiresAt')::timestamptz > now() + interval '365 days 1 minute'
      or (v_session->>'expiresAt')::timestamptz <= now() then raise exception 'PB_INVALID_SESSION'; end if;
    insert into public.pb_sessions(token_hash, person_id, csrf_token, expires_at)
      values (v_session->>'tokenHash', v_session->>'personId', v_session->>'csrfToken', (v_session->>'expiresAt')::timestamptz);
  end loop;
  update public.pb_ledger set state = p_state, revision = revision + 1 where singleton;
  delete from public.pb_import_previews where expires_at <= now();
  -- Never expire committed keys: an old reward request must not become a second payout.
  insert into public.pb_idempotency_results(scope, key_hash, request_hash, result)
    values (p_scope, p_key_hash, p_request_hash, p_result);
  -- A lost password-change response must be recoverable with its original cookie+CSRF
  -- even though that cookie was atomically revoked. The server also verifies the new session is active.
  if p_revoke_actor = p_actor_id and jsonb_array_length(p_sessions) > 0 and p_session_hash is not null then
    insert into public.pb_idempotency_results(scope, key_hash, request_hash, result)
      values ('password-retry:' || p_session_hash, p_key_hash, p_request_hash, p_result);
  end if;
  return jsonb_build_object('committed', true, 'result', p_result);
end $$;

create or replace function public.pb_initialize(p_state jsonb, p_accounts jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_account jsonb;
begin
  -- Shared transaction lock serializes first-setup Vercel instances/CLIs, even on an empty ledger.
  perform pg_advisory_xact_lock(713970412651::bigint);
  if exists (select 1 from public.pb_ledger) or exists (select 1 from public.pb_accounts)
    then raise exception 'PB_ALREADY_INITIALIZED'; end if;
  perform public.pb_validate_state(p_state);
  perform public.pb_validate_accounts(p_accounts, p_state);
  if jsonb_array_length(p_state->'people') <> 5 or jsonb_array_length(p_state->'entries') <> 0
    or jsonb_array_length(p_accounts) <> 5
    or (select array_agg(p->>'id' order by p->>'id') from jsonb_array_elements(p_state->'people') p)
      <> array['aava','elli','hanna','ilkka','stella']::text[]
    or exists (select 1 from jsonb_array_elements(p_state->'people') p
      where (p->>'id' in ('ilkka','hanna')) <> (p->>'role' = 'parent') or p->'archived' <> 'false'::jsonb)
    or exists (select 1 from jsonb_array_elements(p_accounts) as initial_account(value)
      where initial_account.value->'credential'->'mustChange' <> 'true'::jsonb)
    then raise exception 'PB_INVALID_INITIALIZATION'; end if;
  for v_account in select value from jsonb_array_elements(p_accounts) loop
    insert into public.pb_accounts(person_id, username, credential)
      values (v_account->>'personId', v_account->>'username', v_account->'credential');
  end loop;
  if not exists (select 1 from jsonb_array_elements(p_state->'people') p
    join public.pb_accounts as existing_account on existing_account.person_id = p->>'id' where p->>'role' = 'parent')
    then raise exception 'PB_LAST_PARENT'; end if;
  insert into public.pb_ledger(singleton, state, revision) values (true, p_state, 0);
  return jsonb_build_object('ready', true, 'revision', 0);
end $$;

-- Helpers have no externally callable grant. All six RPCs are service_role only.
do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'pb_validate_state','pb_validate_accounts','pb_snapshot','pb_idempotency','pb_rate','pb_preview','pb_commit','pb_initialize')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn.signature);
    if fn.proname not in ('pb_validate_state','pb_validate_accounts') then
      execute format('grant execute on function %s to service_role', fn.signature);
    end if;
  end loop;
end $$;
notify pgrst, 'reload schema';
commit;
