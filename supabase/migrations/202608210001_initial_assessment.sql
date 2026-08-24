-- Paired collaborative assessment: schema, state machine, RLS, realtime, and cleanup.
create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

create type public.attempt_stage as enum (
  'attention', 'waiting', 'instruction', 'chat', 'finalizing', 'quiz', 'complete', 'aborted'
);
create type public.pair_status as enum (
  'instruction', 'chat', 'finalizing', 'approved', 'complete', 'aborted'
);
create type public.proposal_status as enum ('pending', 'rejected', 'accepted');
create type public.queue_status as enum ('waiting', 'expired');
create type public.keystroke_field as enum ('chat', 'story');

create table public.study_versions (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique,
  status text not null check (status in ('active', 'archived')),
  consent_markdown text not null,
  keystroke_disclosure text not null check (length(trim(keystroke_disclosure)) > 0),
  attention_prompt text not null,
  instruction_markdown text not null,
  wait_seconds integer not null default 300 check (wait_seconds between 10 and 3600),
  chat_seconds integer not null default 1200 check (chat_seconds between 10 and 14400),
  reconnect_seconds integer not null default 120 check (reconnect_seconds between 30 and 3600),
  quiz_questions jsonb not null check (jsonb_typeof(quiz_questions) = 'array'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index one_active_study_version on public.study_versions ((status)) where status = 'active';

create table private.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table private.participant_codes (
  id uuid primary key default gen_random_uuid(),
  code_normalized text not null unique,
  code_display text not null,
  status text not null default 'available' check (status in ('available', 'active', 'completed')),
  current_attempt_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pair_sessions (
  id uuid primary key default gen_random_uuid(),
  study_version_id uuid not null references public.study_versions(id),
  status public.pair_status not null default 'instruction',
  paired_at timestamptz not null default now(),
  chat_started_at timestamptz,
  chat_ends_at timestamptz,
  final_story text,
  accepted_proposal_id uuid,
  approved_at timestamptz,
  completed_at timestamptz,
  aborted_at timestamptz
);

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  participant_code_id uuid not null references private.participant_codes(id),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  study_version_id uuid not null references public.study_versions(id),
  pair_session_id uuid references public.pair_sessions(id) on delete set null,
  stage public.attempt_stage not null default 'attention',
  consented_at timestamptz not null default now(),
  attention_response text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index one_bound_attempt_per_auth_user on public.attempts(auth_user_id);
create index attempts_code_idx on public.attempts(participant_code_id, started_at desc);
create index attempts_pair_idx on public.attempts(pair_session_id);
alter table private.participant_codes
  add constraint participant_codes_current_attempt_fk
  foreign key (current_attempt_id) references public.attempts(id) on delete set null;

create table public.queue_entries (
  attempt_id uuid primary key references public.attempts(id) on delete cascade,
  study_version_id uuid not null references public.study_versions(id),
  status public.queue_status not null default 'waiting',
  joined_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index queue_match_idx on public.queue_entries(study_version_id, status, expires_at);

create table public.pair_members (
  pair_session_id uuid not null references public.pair_sessions(id) on delete cascade,
  attempt_id uuid not null unique references public.attempts(id) on delete cascade,
  alias text not null,
  ready_at timestamptz,
  primary key (pair_session_id, attempt_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  pair_session_id uuid not null references public.pair_sessions(id) on delete cascade,
  sender_attempt_id uuid not null references public.attempts(id) on delete cascade,
  client_message_id uuid not null,
  field_instance_id uuid not null,
  body text not null check (length(trim(body)) > 0 and length(body) <= 2000),
  created_at timestamptz not null default now(),
  unique (sender_attempt_id, client_message_id)
);
create index messages_pair_time_idx on public.messages(pair_session_id, created_at, id);

create table public.story_proposals (
  id uuid primary key default gen_random_uuid(),
  pair_session_id uuid not null references public.pair_sessions(id) on delete cascade,
  proposer_attempt_id uuid not null references public.attempts(id) on delete cascade,
  version integer not null,
  body text not null check (length(trim(body)) > 0),
  field_instance_id uuid not null,
  status public.proposal_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique(pair_session_id, version)
);
create index story_proposals_pair_idx on public.story_proposals(pair_session_id, version desc);
alter table public.pair_sessions
  add constraint pair_sessions_accepted_proposal_fk
  foreign key (accepted_proposal_id) references public.story_proposals(id) on delete set null;

create table public.story_approvals (
  proposal_id uuid not null references public.story_proposals(id) on delete cascade,
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  decision text not null check (decision in ('agree', 'disagree')),
  decided_at timestamptz not null default now(),
  primary key (proposal_id, attempt_id)
);

create table public.quiz_responses (
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  question_id text not null,
  answer text not null,
  submitted_at timestamptz not null default now(),
  primary key (attempt_id, question_id)
);

create table public.integrity_events (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  incident_id uuid not null,
  event_type text not null check (event_type in ('tab_hidden', 'window_blur', 'fullscreen_exit', 'fullscreen_error')),
  client_occurred_at timestamptz not null,
  client_details jsonb not null default '{}'::jsonb,
  server_received_at timestamptz not null default now()
);
create index integrity_attempt_time_idx on public.integrity_events(attempt_id, client_occurred_at);

create table public.keystroke_events (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  pair_session_id uuid not null references public.pair_sessions(id) on delete cascade,
  field_type public.keystroke_field not null,
  field_instance_id uuid not null,
  client_event_id uuid not null unique,
  client_sequence bigint not null,
  correlation_id uuid,
  event_kind text not null check (event_kind in ('keydown', 'beforeinput', 'input', 'paste', 'compositionstart', 'compositionupdate', 'compositionend')),
  key_value text,
  code_value text,
  input_type text,
  event_data text,
  client_wall_time timestamptz not null,
  client_elapsed_ms double precision not null,
  server_received_at timestamptz not null default now(),
  selection_start integer,
  selection_end integer,
  selection_start_after integer,
  selection_end_after integer,
  ctrl_key boolean not null default false,
  alt_key boolean not null default false,
  shift_key boolean not null default false,
  meta_key boolean not null default false,
  is_repeat boolean not null default false,
  key_location integer not null default 0,
  is_composing boolean not null default false
);
create index keystrokes_attempt_sequence_idx on public.keystroke_events(attempt_id, client_sequence, id);
create index keystrokes_draft_idx on public.keystroke_events(field_instance_id, client_sequence);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger attempts_touch_updated before update on public.attempts
for each row execute function public.touch_updated_at();
create trigger participant_codes_touch_updated before update on private.participant_codes
for each row execute function public.touch_updated_at();

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = private, public, auth
as $$
  select exists (
    select 1 from private.admin_users
    where user_id = auth.uid() and enabled
  );
$$;

create or replace function public.is_pair_member(p_pair_id uuid)
returns boolean
language sql stable security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.pair_members pm
    join public.attempts a on a.id = pm.attempt_id
    where pm.pair_session_id = p_pair_id and a.auth_user_id = auth.uid()
  );
$$;

create or replace function public.get_pair_presence(p_pair_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth
as $$
begin
  if not public.is_pair_member(p_pair_id) and not public.is_admin() then
    raise exception 'pair membership required';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'attempt_id', pm.attempt_id,
      'alias', pm.alias,
      'ready_at', pm.ready_at,
      'last_seen_at', a.last_seen_at
    ) order by pm.alias)
    from public.pair_members pm
    join public.attempts a on a.id = pm.attempt_id
    where pm.pair_session_id = p_pair_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.register_admin(p_user_id uuid, p_email text)
returns void
language plpgsql security definer
set search_path = private, public, auth
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  insert into private.admin_users(user_id, email, enabled)
  values (p_user_id, lower(trim(p_email)), true)
  on conflict (user_id) do update set email = excluded.email, enabled = true;
end;
$$;

create or replace function public.participant_code_status(p_code text)
returns jsonb
language plpgsql security definer
set search_path = private, public
as $$
declare
  v_code private.participant_codes%rowtype;
  v_stage public.attempt_stage;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  select * into v_code from private.participant_codes
  where code_normalized = upper(trim(p_code));
  if not found then return jsonb_build_object('claimable', false, 'reason', 'unavailable'); end if;
  if v_code.status = 'completed' then return jsonb_build_object('claimable', false, 'reason', 'completed'); end if;
  if v_code.current_attempt_id is not null then
    select stage into v_stage from public.attempts where id = v_code.current_attempt_id;
    if v_stage = 'aborted' then return jsonb_build_object('claimable', false, 'reason', 'aborted'); end if;
  end if;
  return jsonb_build_object('claimable', true);
end;
$$;

create or replace function public.claim_participant_code(p_code text, p_consented boolean)
returns uuid
language plpgsql security definer
set search_path = private, public, auth
as $$
declare
  v_code private.participant_codes%rowtype;
  v_attempt public.attempts%rowtype;
  v_study_id uuid;
begin
  if auth.uid() is null or coalesce(p_consented, false) is false then
    raise exception 'authentication and consent required';
  end if;
  select * into v_code from private.participant_codes
  where code_normalized = upper(trim(p_code)) for update;
  if not found or v_code.status = 'completed' then raise exception 'participant ID unavailable'; end if;

  if v_code.current_attempt_id is not null then
    select * into v_attempt from public.attempts where id = v_code.current_attempt_id for update;
    if v_attempt.stage = 'aborted' then raise exception 'participant ID requires researcher reset'; end if;
    update public.attempts
      set auth_user_id = auth.uid(), last_seen_at = now()
      where id = v_attempt.id;
    return v_attempt.id;
  end if;

  select id into v_study_id from public.study_versions where status = 'active';
  if v_study_id is null then raise exception 'no active study'; end if;
  insert into public.attempts(participant_code_id, auth_user_id, study_version_id)
  values (v_code.id, auth.uid(), v_study_id)
  returning id into v_attempt.id;
  update private.participant_codes
    set status = 'active', current_attempt_id = v_attempt.id
    where id = v_code.id;
  return v_attempt.id;
end;
$$;

create or replace function public.join_waiting_room()
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_me public.attempts%rowtype;
  v_other public.queue_entries%rowtype;
  v_pair uuid;
  v_wait_seconds integer;
  v_aliases text[] := array['Amber Finch','Blue Otter','Cedar Fox','Coral Wren','Golden Hare','Indigo Lynx','Ivory Robin','Jade Badger','Silver Owl','Violet Deer'];
  v_alias_a text;
  v_alias_b text;
begin
  select * into v_me from public.attempts
    where auth_user_id = auth.uid() for update;
  if not found or v_me.stage <> 'waiting' then raise exception 'attempt is not waiting'; end if;
  select wait_seconds into v_wait_seconds from public.study_versions where id = v_me.study_version_id;

  insert into public.queue_entries(attempt_id, study_version_id, status, joined_at, expires_at)
  values (v_me.id, v_me.study_version_id, 'waiting', now(), now() + make_interval(secs => v_wait_seconds))
  on conflict (attempt_id) do update
    set status = 'waiting', joined_at = now(), expires_at = now() + make_interval(secs => v_wait_seconds);

  select q.* into v_other
  from public.queue_entries q
  join public.attempts a on a.id = q.attempt_id
  where q.study_version_id = v_me.study_version_id
    and q.attempt_id <> v_me.id
    and q.status = 'waiting'
    and q.expires_at > now()
    and a.stage = 'waiting'
  order by random()
  for update of q skip locked
  limit 1;

  if not found then return null; end if;
  insert into public.pair_sessions(study_version_id) values (v_me.study_version_id) returning id into v_pair;
  v_alias_a := v_aliases[1 + floor(random() * array_length(v_aliases, 1))::int];
  loop
    v_alias_b := v_aliases[1 + floor(random() * array_length(v_aliases, 1))::int];
    exit when v_alias_b <> v_alias_a;
  end loop;
  insert into public.pair_members(pair_session_id, attempt_id, alias)
    values (v_pair, v_other.attempt_id, v_alias_a), (v_pair, v_me.id, v_alias_b);
  update public.attempts set pair_session_id = v_pair, stage = 'instruction', last_seen_at = now()
    where id in (v_me.id, v_other.attempt_id);
  delete from public.queue_entries where attempt_id in (v_me.id, v_other.attempt_id);
  return v_pair;
end;
$$;

create or replace function public.submit_attention(p_response text)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare v_attempt_id uuid;
begin
  if length(trim(coalesce(p_response, ''))) = 0 then raise exception 'response required'; end if;
  if array_length(regexp_split_to_array(trim(p_response), '\s+'), 1) > 50 then raise exception 'response exceeds 50 words'; end if;
  update public.attempts
    set attention_response = trim(p_response), stage = 'waiting', last_seen_at = now()
    where auth_user_id = auth.uid() and stage = 'attention'
    returning id into v_attempt_id;
  if v_attempt_id is null then raise exception 'invalid attempt stage'; end if;
  perform public.join_waiting_room();
  return v_attempt_id;
end;
$$;

create or replace function public.mark_ready()
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_attempt public.attempts%rowtype;
  v_pair public.pair_sessions%rowtype;
  v_chat_seconds integer;
begin
  select * into v_attempt from public.attempts where auth_user_id = auth.uid() for update;
  if not found or v_attempt.stage <> 'instruction' then raise exception 'invalid attempt stage'; end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id for update;
  if v_pair.status <> 'instruction' then return; end if;
  update public.pair_members set ready_at = coalesce(ready_at, now())
    where pair_session_id = v_pair.id and attempt_id = v_attempt.id;
  if (select count(*) from public.pair_members where pair_session_id = v_pair.id and ready_at is not null) = 2 then
    select chat_seconds into v_chat_seconds from public.study_versions where id = v_attempt.study_version_id;
    update public.pair_sessions set status = 'chat', chat_started_at = now(),
      chat_ends_at = now() + make_interval(secs => v_chat_seconds) where id = v_pair.id;
    update public.attempts set stage = 'chat' where pair_session_id = v_pair.id;
  end if;
end;
$$;

create or replace function public.send_message(
  p_body text, p_client_message_id uuid, p_field_instance_id uuid
)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare v_attempt public.attempts%rowtype; v_id uuid;
begin
  select * into v_attempt from public.attempts where auth_user_id = auth.uid();
  if not found or v_attempt.stage not in ('chat', 'finalizing') then raise exception 'chat is unavailable'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 or length(p_body) > 2000 then raise exception 'invalid message'; end if;
  insert into public.messages(pair_session_id, sender_attempt_id, client_message_id, field_instance_id, body)
  values (v_attempt.pair_session_id, v_attempt.id, p_client_message_id, p_field_instance_id, p_body)
  on conflict (sender_attempt_id, client_message_id) do update set body = public.messages.body
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.propose_story(p_body text, p_field_instance_id uuid)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_attempt public.attempts%rowtype;
  v_pair public.pair_sessions%rowtype;
  v_version integer;
  v_id uuid;
begin
  select * into v_attempt from public.attempts where auth_user_id = auth.uid() for update;
  if not found or v_attempt.stage not in ('chat', 'finalizing') then raise exception 'story submission unavailable'; end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id for update;
  if v_pair.chat_ends_at is null or now() < v_pair.chat_ends_at then raise exception 'chat timer has not ended'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'story required'; end if;
  update public.story_proposals set status = 'rejected', decided_at = now()
    where pair_session_id = v_pair.id and status = 'pending';
  select coalesce(max(version), 0) + 1 into v_version from public.story_proposals where pair_session_id = v_pair.id;
  insert into public.story_proposals(pair_session_id, proposer_attempt_id, version, body, field_instance_id)
  values (v_pair.id, v_attempt.id, v_version, p_body, p_field_instance_id) returning id into v_id;
  update public.pair_sessions set status = 'finalizing' where id = v_pair.id;
  update public.attempts set stage = 'finalizing' where pair_session_id = v_pair.id;
  return v_id;
end;
$$;

create or replace function public.decide_story(p_proposal_id uuid, p_decision text)
returns void
language plpgsql security definer
set search_path = public, auth, private
as $$
declare
  v_attempt public.attempts%rowtype;
  v_proposal public.story_proposals%rowtype;
begin
  if p_decision not in ('agree', 'disagree') then raise exception 'invalid decision'; end if;
  select * into v_attempt from public.attempts where auth_user_id = auth.uid() for update;
  if not found or v_attempt.stage <> 'finalizing' then raise exception 'invalid attempt stage'; end if;
  select * into v_proposal from public.story_proposals where id = p_proposal_id for update;
  if not found or v_proposal.pair_session_id <> v_attempt.pair_session_id or v_proposal.status <> 'pending' then
    raise exception 'proposal unavailable';
  end if;
  insert into public.story_approvals(proposal_id, attempt_id, decision)
  values (p_proposal_id, v_attempt.id, p_decision)
  on conflict (proposal_id, attempt_id) do update set decision = excluded.decision, decided_at = now();
  if p_decision = 'disagree' then
    update public.story_proposals set status = 'rejected', decided_at = now() where id = p_proposal_id;
    return;
  end if;
  if (select count(*) from public.story_approvals where proposal_id = p_proposal_id and decision = 'agree') = 2 then
    update public.story_proposals set status = 'accepted', decided_at = now() where id = p_proposal_id;
    update public.pair_sessions set status = 'approved', final_story = v_proposal.body,
      accepted_proposal_id = p_proposal_id, approved_at = now() where id = v_proposal.pair_session_id;
    update public.attempts set stage = 'quiz' where pair_session_id = v_proposal.pair_session_id;
  end if;
end;
$$;

create or replace function public.submit_quiz(p_answers jsonb)
returns void
language plpgsql security definer
set search_path = public, auth, private
as $$
declare
  v_attempt public.attempts%rowtype;
  v_questions jsonb;
  v_question jsonb;
  v_answer text;
begin
  select * into v_attempt from public.attempts where auth_user_id = auth.uid() for update;
  if not found or v_attempt.stage <> 'quiz' then raise exception 'quiz unavailable'; end if;
  if jsonb_typeof(p_answers) <> 'object' then raise exception 'answers must be an object'; end if;
  select quiz_questions into v_questions from public.study_versions where id = v_attempt.study_version_id;
  for v_question in select value from jsonb_array_elements(v_questions) loop
    v_answer := p_answers ->> (v_question ->> 'id');
    if v_answer is null or not exists (
      select 1 from jsonb_array_elements(v_question -> 'options') option
      where option ->> 'value' = v_answer
    ) then raise exception 'all quiz questions require a valid answer'; end if;
    insert into public.quiz_responses(attempt_id, question_id, answer)
    values (v_attempt.id, v_question ->> 'id', v_answer)
    on conflict (attempt_id, question_id) do update set answer = excluded.answer, submitted_at = now();
  end loop;
  update public.attempts set stage = 'complete', completed_at = now() where id = v_attempt.id;
  update private.participant_codes set status = 'completed' where id = v_attempt.participant_code_id;
  if v_attempt.pair_session_id is not null and not exists (
    select 1 from public.attempts where pair_session_id = v_attempt.pair_session_id and stage <> 'complete'
  ) then
    update public.pair_sessions set status = 'complete', completed_at = now() where id = v_attempt.pair_session_id;
  end if;
end;
$$;

create or replace function public.record_heartbeat()
returns void language sql security definer set search_path = public, auth as $$
  update public.attempts set last_seen_at = now()
  where auth_user_id = auth.uid() and stage not in ('complete', 'aborted');
$$;

create or replace function public.record_integrity_event(
  p_incident_id uuid, p_event_type text, p_client_occurred_at timestamptz, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql security definer set search_path = public, auth as $$
declare v_attempt_id uuid;
begin
  select id into v_attempt_id from public.attempts where auth_user_id = auth.uid()
    and stage not in ('complete', 'aborted');
  if v_attempt_id is null then return; end if;
  insert into public.integrity_events(attempt_id, incident_id, event_type, client_occurred_at, client_details)
  values (v_attempt_id, p_incident_id, p_event_type, p_client_occurred_at, coalesce(p_details, '{}'::jsonb));
end;
$$;

create or replace function public.append_keystroke_batch(p_events jsonb)
returns integer
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_attempt public.attempts%rowtype;
  v_event jsonb;
  v_count integer := 0;
begin
  select * into v_attempt from public.attempts where auth_user_id = auth.uid();
  if not found or v_attempt.stage not in ('chat', 'finalizing', 'quiz', 'complete') then raise exception 'keystroke capture unavailable'; end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 200 then raise exception 'invalid event batch'; end if;
  for v_event in select value from jsonb_array_elements(p_events) loop
    if (v_event ->> 'pairSessionId')::uuid <> v_attempt.pair_session_id then raise exception 'invalid pair'; end if;
    if v_event ->> 'fieldType' not in ('chat', 'story') then raise exception 'invalid field'; end if;
    insert into public.keystroke_events(
      attempt_id, pair_session_id, field_type, field_instance_id, client_event_id, client_sequence,
      correlation_id, event_kind, key_value, code_value, input_type, event_data,
      client_wall_time, client_elapsed_ms, selection_start, selection_end,
      selection_start_after, selection_end_after, ctrl_key, alt_key, shift_key, meta_key,
      is_repeat, key_location, is_composing
    ) values (
      v_attempt.id, v_attempt.pair_session_id, (v_event ->> 'fieldType')::public.keystroke_field,
      (v_event ->> 'fieldInstanceId')::uuid, (v_event ->> 'clientEventId')::uuid,
      (v_event ->> 'clientSequence')::bigint, nullif(v_event ->> 'correlationId', '')::uuid,
      v_event ->> 'eventKind', v_event ->> 'keyValue', v_event ->> 'codeValue',
      v_event ->> 'inputType', v_event ->> 'eventData', (v_event ->> 'clientWallTime')::timestamptz,
      (v_event ->> 'clientElapsedMs')::double precision, (v_event ->> 'selectionStart')::integer,
      (v_event ->> 'selectionEnd')::integer, (v_event ->> 'selectionStartAfter')::integer,
      (v_event ->> 'selectionEndAfter')::integer, coalesce((v_event ->> 'ctrlKey')::boolean, false),
      coalesce((v_event ->> 'altKey')::boolean, false), coalesce((v_event ->> 'shiftKey')::boolean, false),
      coalesce((v_event ->> 'metaKey')::boolean, false), coalesce((v_event ->> 'isRepeat')::boolean, false),
      coalesce((v_event ->> 'keyLocation')::integer, 0), coalesce((v_event ->> 'isComposing')::boolean, false)
    ) on conflict (client_event_id) do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.admin_import_codes(p_codes jsonb)
returns jsonb
language plpgsql security definer set search_path = private, public, auth as $$
declare v_item jsonb; v_code text; v_inserted integer := 0; v_duplicates integer := 0;
begin
  if not public.is_admin() then raise exception 'administrator required'; end if;
  if jsonb_typeof(p_codes) <> 'array' then raise exception 'codes must be an array'; end if;
  for v_item in select value from jsonb_array_elements(p_codes) loop
    v_code := trim(v_item #>> '{}');
    if v_code <> '' then
      insert into private.participant_codes(code_normalized, code_display)
      values (upper(v_code), v_code) on conflict (code_normalized) do nothing;
      if found then v_inserted := v_inserted + 1; else v_duplicates := v_duplicates + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_duplicates);
end;
$$;

create or replace function public.admin_publish_study(p_config jsonb)
returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_version integer;
begin
  if not public.is_admin() then raise exception 'administrator required'; end if;
  if length(trim(coalesce(p_config ->> 'keystrokeDisclosure', ''))) = 0 then raise exception 'keystroke disclosure required'; end if;
  if jsonb_typeof(p_config -> 'quizQuestions') <> 'array' or jsonb_array_length(p_config -> 'quizQuestions') = 0 then
    raise exception 'quiz questions required';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.study_versions;
  update public.study_versions set status = 'archived' where status = 'active';
  insert into public.study_versions(
    version, status, consent_markdown, keystroke_disclosure, attention_prompt, instruction_markdown,
    wait_seconds, chat_seconds, reconnect_seconds, quiz_questions, created_by
  ) values (
    v_version, 'active', p_config ->> 'consentMarkdown', p_config ->> 'keystrokeDisclosure',
    p_config ->> 'attentionPrompt', p_config ->> 'instructionMarkdown',
    (p_config ->> 'waitSeconds')::integer, (p_config ->> 'chatSeconds')::integer,
    (p_config ->> 'reconnectSeconds')::integer, p_config -> 'quizQuestions', auth.uid()
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.admin_reset_code(p_code_id uuid)
returns void
language plpgsql security definer set search_path = private, public, auth as $$
declare v_attempt_id uuid; v_pair_id uuid;
begin
  if not public.is_admin() then raise exception 'administrator required'; end if;
  select current_attempt_id into v_attempt_id from private.participant_codes where id = p_code_id for update;
  if v_attempt_id is not null then
    select pair_session_id into v_pair_id from public.attempts where id = v_attempt_id;
    if v_pair_id is not null then
      update public.pair_sessions set status = 'aborted', aborted_at = now()
        where id = v_pair_id and status not in ('complete', 'aborted');
      update public.attempts set stage = 'aborted' where pair_session_id = v_pair_id and stage <> 'complete';
    else
      update public.attempts set stage = 'aborted' where id = v_attempt_id and stage <> 'complete';
    end if;
  end if;
  update private.participant_codes set status = 'available', current_attempt_id = null where id = p_code_id;
end;
$$;

create or replace function public.admin_delete_pair(p_pair_id uuid)
returns void
language plpgsql security definer set search_path = private, public, auth as $$
declare v_attempt_ids uuid[];
begin
  if not public.is_admin() then raise exception 'administrator required'; end if;
  select array_agg(attempt_id) into v_attempt_ids from public.pair_members where pair_session_id = p_pair_id;
  update private.participant_codes set current_attempt_id = null
    where current_attempt_id = any(coalesce(v_attempt_ids, array[]::uuid[]));
  delete from public.pair_sessions where id = p_pair_id;
  delete from public.attempts where id = any(coalesce(v_attempt_ids, array[]::uuid[]));
end;
$$;

create or replace function public.admin_codes_for_export()
returns jsonb
language sql security definer set search_path = private, public, auth as $$
  select case when public.is_admin() or auth.role() = 'service_role'
    then coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
    else '[]'::jsonb end
  from private.participant_codes c;
$$;

create or replace function public.cleanup_assessment()
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.queue_entries set status = 'expired'
    where status = 'waiting' and expires_at <= now();
  update public.pair_sessions ps set status = 'aborted', aborted_at = now()
  where ps.status in ('instruction', 'chat', 'finalizing') and exists (
    select 1 from public.pair_members pm
    join public.attempts a on a.id = pm.attempt_id
    join public.study_versions sv on sv.id = a.study_version_id
    where pm.pair_session_id = ps.id
      and a.last_seen_at < now() - make_interval(secs => sv.reconnect_seconds)
  );
  update public.attempts a set stage = 'aborted'
  from public.pair_sessions ps
  where a.pair_session_id = ps.id and ps.status = 'aborted' and a.stage <> 'complete';
end;
$$;

-- Realtime update hints. Clients always refetch durable state after an event.
create or replace function public.broadcast_assessment_change()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare v_pair uuid; v_attempt uuid; v_payload jsonb;
begin
  v_payload := jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP);
  if TG_TABLE_NAME = 'attempts' then
    v_attempt := new.id; v_pair := new.pair_session_id;
  elsif TG_TABLE_NAME = 'pair_sessions' then v_pair := new.id;
  elsif TG_TABLE_NAME = 'pair_members' then v_pair := new.pair_session_id;
    v_attempt := new.attempt_id;
  elsif TG_TABLE_NAME in ('messages', 'story_proposals') then v_pair := new.pair_session_id;
  elsif TG_TABLE_NAME = 'story_approvals' then
    select pair_session_id into v_pair from public.story_proposals where id = new.proposal_id;
  end if;
  if v_attempt is not null then perform realtime.send(v_payload, 'state_changed', 'attempt:' || v_attempt::text, true); end if;
  if v_pair is not null then perform realtime.send(v_payload, 'state_changed', 'pair:' || v_pair::text, true); end if;
  return new;
end;
$$;
create trigger attempts_broadcast after insert or update on public.attempts for each row execute function public.broadcast_assessment_change();
create trigger pairs_broadcast after insert or update on public.pair_sessions for each row execute function public.broadcast_assessment_change();
create trigger members_broadcast after insert or update on public.pair_members for each row execute function public.broadcast_assessment_change();
create trigger messages_broadcast after insert on public.messages for each row execute function public.broadcast_assessment_change();
create trigger proposals_broadcast after insert or update on public.story_proposals for each row execute function public.broadcast_assessment_change();
create trigger approvals_broadcast after insert or update on public.story_approvals for each row execute function public.broadcast_assessment_change();

alter table public.study_versions enable row level security;
alter table public.attempts enable row level security;
alter table public.queue_entries enable row level security;
alter table public.pair_sessions enable row level security;
alter table public.pair_members enable row level security;
alter table public.messages enable row level security;
alter table public.story_proposals enable row level security;
alter table public.story_approvals enable row level security;
alter table public.quiz_responses enable row level security;
alter table public.integrity_events enable row level security;
alter table public.keystroke_events enable row level security;

create policy study_versions_read on public.study_versions for select to authenticated using (
  public.is_admin() or status = 'active' or exists (
    select 1 from public.attempts a where a.study_version_id = study_versions.id and a.auth_user_id = auth.uid()
  )
);
create policy attempts_read on public.attempts for select to authenticated using (auth_user_id = auth.uid() or public.is_admin());
create policy queue_read on public.queue_entries for select to authenticated using (
  public.is_admin() or exists (select 1 from public.attempts a where a.id = attempt_id and a.auth_user_id = auth.uid())
);
create policy pair_sessions_read on public.pair_sessions for select to authenticated using (
  public.is_admin() or public.is_pair_member(id)
);
create policy pair_members_read on public.pair_members for select to authenticated using (
  public.is_admin() or public.is_pair_member(pair_session_id)
);
create policy messages_read on public.messages for select to authenticated using (
  public.is_admin() or public.is_pair_member(pair_session_id)
);
create policy proposals_read on public.story_proposals for select to authenticated using (
  public.is_admin() or public.is_pair_member(pair_session_id)
);
create policy approvals_read on public.story_approvals for select to authenticated using (
  public.is_admin() or exists (
    select 1 from public.story_proposals sp
    where sp.id = story_approvals.proposal_id and public.is_pair_member(sp.pair_session_id)
  )
);
create policy quiz_read on public.quiz_responses for select to authenticated using (
  public.is_admin() or exists (select 1 from public.attempts a where a.id = attempt_id and a.auth_user_id = auth.uid())
);
create policy integrity_admin_read on public.integrity_events for select to authenticated using (public.is_admin());
create policy keystrokes_admin_read on public.keystroke_events for select to authenticated using (public.is_admin());

create policy private_channel_read on realtime.messages for select to authenticated using (
  public.is_admin()
  or (
    realtime.topic() like 'attempt:%' and exists (
      select 1 from public.attempts a where a.id::text = split_part(realtime.topic(), ':', 2) and a.auth_user_id = auth.uid()
    )
  )
  or (
    realtime.topic() like 'pair:%'
    and public.is_pair_member(nullif(split_part(realtime.topic(), ':', 2), '')::uuid)
  )
);

revoke all on all tables in schema private from anon, authenticated;
revoke all on public.keystroke_events, public.integrity_events from anon, authenticated;
grant select on public.study_versions, public.attempts, public.queue_entries, public.pair_sessions,
  public.pair_members, public.messages, public.story_proposals, public.story_approvals, public.quiz_responses
  to authenticated;
grant select on realtime.messages to authenticated;

revoke all on function public.register_admin(uuid, text) from public, anon, authenticated;
revoke all on function public.participant_code_status(text) from public, anon, authenticated;
revoke all on function public.cleanup_assessment() from public, anon, authenticated;
revoke all on function public.admin_codes_for_export() from public, anon, authenticated;
grant execute on function public.register_admin(uuid, text) to service_role;
grant execute on function public.participant_code_status(text) to service_role;
grant execute on function public.cleanup_assessment() to service_role;
grant execute on function public.admin_codes_for_export() to service_role, authenticated;
grant execute on function public.is_admin(), public.is_pair_member(uuid), public.get_pair_presence(uuid), public.claim_participant_code(text, boolean),
  public.join_waiting_room(), public.submit_attention(text), public.mark_ready(),
  public.send_message(text, uuid, uuid), public.propose_story(text, uuid),
  public.decide_story(uuid, text), public.submit_quiz(jsonb), public.record_heartbeat(),
  public.record_integrity_event(uuid, text, timestamptz, jsonb), public.append_keystroke_batch(jsonb),
  public.admin_import_codes(jsonb), public.admin_publish_study(jsonb),
  public.admin_reset_code(uuid), public.admin_delete_pair(uuid)
  to authenticated;

insert into public.study_versions(
  version, status, consent_markdown, keystroke_disclosure, attention_prompt,
  instruction_markdown, wait_seconds, chat_seconds, reconnect_seconds, quiz_questions
) values (
  1,
  'active',
  '## Study consent\n\nThis is placeholder consent language. Replace it with the ethics-approved text before running the study.',
  'This study records each key you press in the chat and final-story fields. Deleted and unfinished drafts, pasted text, autocomplete, and composed characters may be retained. The website cannot observe typing in other tabs or applications.',
  'Complete this sentence in 50 words or fewer: When two people create a story together, the most important thing is …',
  'Work with your partner to create one final story. You have 20 minutes to discuss ideas through chat. When time ends, either person may propose the final story. Both people must approve the same version before continuing.',
  300,
  1200,
  120,
  '[
    {"id":"clarity","prompt":"How clearly did you understand the task?","options":[{"value":"1","label":"Not at all clearly"},{"value":"2","label":"Slightly clearly"},{"value":"3","label":"Moderately clearly"},{"value":"4","label":"Very clearly"},{"value":"5","label":"Completely clearly"}]},
    {"id":"collaboration","prompt":"How well did you and your partner collaborate?","options":[{"value":"1","label":"Very poorly"},{"value":"2","label":"Poorly"},{"value":"3","label":"Neither poorly nor well"},{"value":"4","label":"Well"},{"value":"5","label":"Very well"}]},
    {"id":"satisfaction","prompt":"How satisfied are you with the final story?","options":[{"value":"1","label":"Very dissatisfied"},{"value":"2","label":"Dissatisfied"},{"value":"3","label":"Neither satisfied nor dissatisfied"},{"value":"4","label":"Satisfied"},{"value":"5","label":"Very satisfied"}]}
  ]'::jsonb
);

select cron.schedule(
  'paired-assessment-cleanup',
  '15 seconds',
  $$select public.cleanup_assessment();$$
);
