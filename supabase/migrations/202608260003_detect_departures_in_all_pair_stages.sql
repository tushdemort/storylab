begin;

create or replace function public.mark_pair_departure()
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare v_attempt public.attempts%rowtype;
begin
  select * into v_attempt from public.attempts
  where auth_user_id = auth.uid() for update;
  if not found
    or v_attempt.stage not in ('instruction', 'chat', 'finalizing')
    or v_attempt.pair_session_id is null then return;
  end if;

  update public.pair_sessions
  set disconnected_attempt_id = v_attempt.id, disconnect_detected_at = now()
  where id = v_attempt.pair_session_id
    and status in ('instruction', 'chat', 'finalizing')
    and disconnected_attempt_id is null;
end;
$$;

-- Retain the original RPC name for clients that still have an older bundle.
create or replace function public.mark_instruction_departure()
returns void
language plpgsql security definer
set search_path = public, auth
as $$
begin
  perform public.mark_pair_departure();
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

  if found
    and v_attempt.stage in ('instruction', 'chat', 'finalizing')
    and v_attempt.pair_session_id is not null then
    update public.pair_sessions
    set disconnected_attempt_id = null, disconnect_detected_at = null
    where id = v_attempt.pair_session_id
      and status in ('instruction', 'chat', 'finalizing')
      and disconnected_attempt_id = v_attempt.id;
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

  -- Any paired-stage heartbeat after detection restores the original pair.
  update public.pair_sessions ps
  set disconnected_attempt_id = null, disconnect_detected_at = null
  from public.attempts a
  where ps.status in ('instruction', 'chat', 'finalizing')
    and ps.disconnected_attempt_id = a.id
    and a.last_seen_at > ps.disconnect_detected_at;

  -- Browser-close reporting normally starts this immediately. This is the
  -- fallback for power loss or network loss where no pagehide request arrives.
  update public.pair_sessions ps
  set disconnected_attempt_id = (
        select pm.attempt_id
        from public.pair_members pm
        join public.attempts a on a.id = pm.attempt_id
        where pm.pair_session_id = ps.id
          and a.pair_session_id = ps.id
          and a.stage in ('instruction', 'chat', 'finalizing')
          and a.last_seen_at <= now() - interval '30 seconds'
        order by a.last_seen_at
        limit 1
      ),
      disconnect_detected_at = now()
  where ps.status in ('instruction', 'chat', 'finalizing')
    and ps.disconnected_attempt_id is null
    and exists (
      select 1
      from public.pair_members pm
      join public.attempts a on a.id = pm.attempt_id
      where pm.pair_session_id = ps.id
        and a.pair_session_id = ps.id
        and a.stage in ('instruction', 'chat', 'finalizing')
        and a.last_seen_at <= now() - interval '30 seconds'
    );

  -- Before chat starts, preserve the active participant and return only that
  -- person to matchmaking when the reconnect grace period expires.
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

  -- Once chat has started, show the same grace period but end the original
  -- session after timeout instead of inserting a new partner mid-assessment.
  update public.pair_sessions ps
  set status = 'aborted', aborted_at = now()
  from public.study_versions sv, public.attempts leaver
  where ps.study_version_id = sv.id
    and ps.status in ('chat', 'finalizing')
    and ps.disconnected_attempt_id = leaver.id
    and ps.disconnect_detected_at + make_interval(secs => sv.reconnect_seconds) <= now()
    and leaver.last_seen_at <= ps.disconnect_detected_at;

  update public.attempts a set stage = 'aborted'
  from public.pair_sessions ps
  where a.pair_session_id = ps.id and ps.status = 'aborted' and a.stage <> 'complete';

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

revoke all on function public.mark_pair_departure() from public, anon;
grant execute on function public.mark_pair_departure() to authenticated;

commit;
