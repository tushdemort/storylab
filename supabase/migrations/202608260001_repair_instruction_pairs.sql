begin;

alter table public.pair_sessions
  add column if not exists disconnected_attempt_id uuid,
  add column if not exists disconnect_detected_at timestamptz;

alter table public.pair_sessions
  drop constraint if exists pair_sessions_disconnect_state_check;
alter table public.pair_sessions
  add constraint pair_sessions_disconnect_state_check check (
    (disconnected_attempt_id is null and disconnect_detected_at is null)
    or (disconnected_attempt_id is not null and disconnect_detected_at is not null)
  );

create or replace function private.try_match_waiting_attempt(p_attempt_id uuid)
returns uuid
language plpgsql security definer
set search_path = public, private
as $$
declare
  v_me public.attempts%rowtype;
  v_me_queue public.queue_entries%rowtype;
  v_other public.queue_entries%rowtype;
  v_pair uuid;
  v_aliases text[] := array['Amber Finch','Blue Otter','Cedar Fox','Coral Wren','Golden Hare','Indigo Lynx','Ivory Robin','Jade Badger','Silver Owl','Violet Deer'];
  v_alias_a text;
  v_alias_b text;
  v_matched_count integer;
begin
  select * into v_me from public.attempts where id = p_attempt_id;
  if not found then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended('assessment-pairing:' || v_me.study_version_id::text, 0));

  select * into v_me from public.attempts where id = p_attempt_id for update;
  if not found or v_me.stage <> 'waiting' or v_me.pair_session_id is not null then return null; end if;

  select * into v_me_queue from public.queue_entries
  where attempt_id = v_me.id and status = 'waiting' and expires_at > now()
  for update;
  if not found then return null; end if;

  select q.* into v_other
  from public.queue_entries q
  join public.attempts a on a.id = q.attempt_id
  where q.study_version_id = v_me.study_version_id
    and q.attempt_id <> v_me.id
    and q.status = 'waiting'
    and q.expires_at > now()
    and a.stage = 'waiting'
    and a.pair_session_id is null
    and a.last_seen_at > now() - interval '45 seconds'
  order by random()
  for update of q
  limit 1;

  if not found then return null; end if;

  insert into public.pair_sessions(study_version_id)
  values (v_me.study_version_id)
  returning id into v_pair;

  v_alias_a := v_aliases[1 + floor(random() * array_length(v_aliases, 1))::int];
  loop
    v_alias_b := v_aliases[1 + floor(random() * array_length(v_aliases, 1))::int];
    exit when v_alias_b <> v_alias_a;
  end loop;

  insert into public.pair_members(pair_session_id, attempt_id, alias)
  values (v_pair, v_other.attempt_id, v_alias_a), (v_pair, v_me.id, v_alias_b);

  update public.attempts
  set pair_session_id = v_pair, stage = 'instruction', last_seen_at = now()
  where id in (v_me.id, v_other.attempt_id) and stage = 'waiting' and pair_session_id is null;

  get diagnostics v_matched_count = row_count;
  if v_matched_count <> 2 then raise exception 'a waiting participant changed state during matching'; end if;

  delete from public.queue_entries where attempt_id in (v_me.id, v_other.attempt_id);
  return v_pair;
end;
$$;

revoke all on function private.try_match_waiting_attempt(uuid) from public, anon, authenticated;

create or replace function public.join_waiting_room()
returns uuid
language plpgsql security definer
set search_path = public, auth, private
as $$
declare
  v_me public.attempts%rowtype;
  v_wait_seconds integer;
begin
  select * into v_me from public.attempts where auth_user_id = auth.uid();
  if not found or v_me.stage <> 'waiting' then raise exception 'attempt is not waiting'; end if;

  perform pg_advisory_xact_lock(hashtextextended('assessment-pairing:' || v_me.study_version_id::text, 0));

  select * into v_me from public.attempts
  where id = v_me.id for update;
  if v_me.stage <> 'waiting' or v_me.pair_session_id is not null then raise exception 'attempt is not waiting'; end if;

  select wait_seconds into v_wait_seconds
  from public.study_versions where id = v_me.study_version_id;

  update public.attempts set last_seen_at = now() where id = v_me.id;
  insert into public.queue_entries(attempt_id, study_version_id, status, joined_at, expires_at)
  values (v_me.id, v_me.study_version_id, 'waiting', now(), now() + make_interval(secs => v_wait_seconds))
  on conflict (attempt_id) do update
    set status = 'waiting', joined_at = now(), expires_at = now() + make_interval(secs => v_wait_seconds);

  return private.try_match_waiting_attempt(v_me.id);
end;
$$;

create or replace function public.mark_instruction_departure()
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare v_attempt public.attempts%rowtype;
begin
  select * into v_attempt from public.attempts
  where auth_user_id = auth.uid() for update;
  if not found or v_attempt.stage <> 'instruction' or v_attempt.pair_session_id is null then return; end if;

  update public.pair_sessions
  set disconnected_attempt_id = v_attempt.id, disconnect_detected_at = now()
  where id = v_attempt.pair_session_id
    and status = 'instruction'
    and disconnected_attempt_id is null;
end;
$$;

create or replace function public.record_heartbeat()
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare v_attempt public.attempts%rowtype;
begin
  update public.attempts
  set last_seen_at = now()
  where auth_user_id = auth.uid() and stage not in ('complete', 'aborted')
  returning * into v_attempt;

  if found and v_attempt.stage = 'instruction' and v_attempt.pair_session_id is not null then
    update public.pair_sessions
    set disconnected_attempt_id = null, disconnect_detected_at = null
    where id = v_attempt.pair_session_id
      and status = 'instruction'
      and disconnected_attempt_id = v_attempt.id;
  end if;
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
  if v_pair.disconnected_attempt_id is not null or exists (
    select 1
    from public.pair_members pm
    join public.attempts a on a.id = pm.attempt_id
    where pm.pair_session_id = v_pair.id
      and pm.attempt_id <> v_attempt.id
      and a.last_seen_at <= now() - interval '30 seconds'
  ) then
    raise exception 'your partner is reconnecting';
  end if;

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

create or replace function public.cleanup_assessment()
returns void
language plpgsql security definer
set search_path = public, private
as $$
declare
  v_candidate record;
  v_pair public.pair_sessions%rowtype;
  v_leaver public.attempts%rowtype;
  v_survivor public.attempts%rowtype;
  v_wait_seconds integer;
  v_attempt_id uuid;
begin
  update public.queue_entries set status = 'expired'
  where status = 'waiting' and expires_at <= now();

  -- A heartbeat after detection means the participant made it back in time.
  update public.pair_sessions ps
  set disconnected_attempt_id = null, disconnect_detected_at = null
  from public.attempts a
  where ps.status = 'instruction'
    and ps.disconnected_attempt_id = a.id
    and a.last_seen_at > ps.disconnect_detected_at;

  -- Heartbeats run every 20 seconds. Thirty seconds without one is treated as
  -- a connection loss and starts the study-version reconnect grace period.
  update public.pair_sessions ps
  set disconnected_attempt_id = (
        select pm.attempt_id
        from public.pair_members pm
        join public.attempts a on a.id = pm.attempt_id
        where pm.pair_session_id = ps.id
          and a.stage = 'instruction'
          and a.pair_session_id = ps.id
          and a.last_seen_at <= now() - interval '30 seconds'
        order by a.last_seen_at
        limit 1
      ),
      disconnect_detected_at = now()
  where ps.status = 'instruction'
    and ps.disconnected_attempt_id is null
    and exists (
      select 1
      from public.pair_members pm
      join public.attempts a on a.id = pm.attempt_id
      where pm.pair_session_id = ps.id
        and a.stage = 'instruction'
        and a.pair_session_id = ps.id
        and a.last_seen_at <= now() - interval '30 seconds'
    );

  for v_candidate in
    select ps.id
    from public.pair_sessions ps
    join public.study_versions sv on sv.id = ps.study_version_id
    where ps.status = 'instruction'
      and ps.disconnected_attempt_id is not null
      and ps.disconnect_detected_at + make_interval(secs => sv.reconnect_seconds) <= now()
  loop
    select * into v_pair from public.pair_sessions where id = v_candidate.id;
    if not found or v_pair.status <> 'instruction' or v_pair.disconnected_attempt_id is null then continue; end if;

    select * into v_leaver from public.attempts
    where id = v_pair.disconnected_attempt_id for update;
    select * into v_pair from public.pair_sessions
    where id = v_pair.id for update;

    if v_pair.status <> 'instruction' or v_pair.disconnected_attempt_id <> v_leaver.id then continue; end if;
    if v_leaver.last_seen_at > v_pair.disconnect_detected_at then
      update public.pair_sessions
      set disconnected_attempt_id = null, disconnect_detected_at = null
      where id = v_pair.id;
      continue;
    end if;

    v_survivor := null;
    select a.* into v_survivor
    from public.pair_members pm
    join public.attempts a on a.id = pm.attempt_id
    where pm.pair_session_id = v_pair.id
      and pm.attempt_id <> v_leaver.id
      and a.stage = 'instruction'
      and a.pair_session_id = v_pair.id
      and a.last_seen_at > now() - interval '45 seconds'
    limit 1
    for update of a;

    update public.pair_sessions
    set status = 'aborted', aborted_at = now()
    where id = v_pair.id;

    if v_survivor.id is null then
      update public.attempts
      set stage = 'aborted'
      where pair_session_id = v_pair.id and stage <> 'complete';
    else
      update public.attempts
      set stage = 'aborted'
      where id = v_leaver.id and pair_session_id = v_pair.id and stage <> 'complete';

      -- Remove only the continuing participant from the abandoned pair. This
      -- keeps pair_members.attempt_id unique and prevents deleting the old pair
      -- from ever deleting a later, successfully re-paired attempt.
      delete from public.pair_members
      where pair_session_id = v_pair.id and attempt_id = v_survivor.id;

      update public.attempts
      set stage = 'waiting', pair_session_id = null, last_seen_at = now()
      where id = v_survivor.id and pair_session_id = v_pair.id;

      select wait_seconds into v_wait_seconds
      from public.study_versions where id = v_survivor.study_version_id;
      insert into public.queue_entries(attempt_id, study_version_id, status, joined_at, expires_at)
      values (v_survivor.id, v_survivor.study_version_id, 'waiting', now(), now() + make_interval(secs => v_wait_seconds))
      on conflict (attempt_id) do update
        set status = 'waiting', joined_at = now(), expires_at = now() + make_interval(secs => v_wait_seconds);
    end if;
  end loop;

  -- Once collaboration has begun, retain the existing study rule: a prolonged
  -- disconnect aborts the shared session rather than introducing a new partner.
  update public.pair_sessions ps set status = 'aborted', aborted_at = now()
  where ps.status in ('chat', 'finalizing') and exists (
    select 1 from public.pair_members pm
    join public.attempts a on a.id = pm.attempt_id
    join public.study_versions sv on sv.id = a.study_version_id
    where pm.pair_session_id = ps.id
      and a.pair_session_id = ps.id
      and a.last_seen_at < now() - make_interval(secs => sv.reconnect_seconds)
  );

  update public.attempts a set stage = 'aborted'
  from public.pair_sessions ps
  where a.pair_session_id = ps.id and ps.status = 'aborted' and a.stage <> 'complete';

  -- This also pairs two survivors requeued by the same cleanup pass instead of
  -- making them wait for a third participant to enter the pool.
  for v_attempt_id in
    select q.attempt_id
    from public.queue_entries q
    join public.attempts a on a.id = q.attempt_id
    where q.status = 'waiting' and q.expires_at > now()
      and a.stage = 'waiting' and a.pair_session_id is null
      and a.last_seen_at > now() - interval '45 seconds'
    order by random()
  loop
    perform private.try_match_waiting_attempt(v_attempt_id);
  end loop;
end;
$$;

revoke all on function public.mark_instruction_departure() from public, anon;
grant execute on function public.mark_instruction_departure() to authenticated;

commit;
