begin;

do $$
declare
  v_study_id uuid;
  v_reconnect_seconds integer;
  v_old_pair uuid := '10000000-0000-0000-0000-000000000001';
  v_return_pair uuid := '10000000-0000-0000-0000-000000000002';
  v_leaver uuid := '20000000-0000-0000-0000-000000000001';
  v_survivor uuid := '20000000-0000-0000-0000-000000000002';
  v_waiter uuid := '20000000-0000-0000-0000-000000000003';
  v_returning uuid := '20000000-0000-0000-0000-000000000004';
  v_return_partner uuid := '20000000-0000-0000-0000-000000000005';
  v_new_pair uuid;
  v_stage public.attempt_stage;
  v_status public.pair_status;
  v_count integer;
begin
  select id, reconnect_seconds into v_study_id, v_reconnect_seconds
  from public.study_versions where status = 'active';

  insert into auth.users(id, is_anonymous) values
    ('30000000-0000-0000-0000-000000000001', true),
    ('30000000-0000-0000-0000-000000000002', true),
    ('30000000-0000-0000-0000-000000000003', true),
    ('30000000-0000-0000-0000-000000000004', true),
    ('30000000-0000-0000-0000-000000000005', true);

  insert into private.participant_codes(id, code_normalized, code_display) values
    ('40000000-0000-0000-0000-000000000001', '__REPAIR_TEST_A__', '__REPAIR_TEST_A__'),
    ('40000000-0000-0000-0000-000000000002', '__REPAIR_TEST_B__', '__REPAIR_TEST_B__'),
    ('40000000-0000-0000-0000-000000000003', '__REPAIR_TEST_C__', '__REPAIR_TEST_C__'),
    ('40000000-0000-0000-0000-000000000004', '__REPAIR_TEST_D__', '__REPAIR_TEST_D__'),
    ('40000000-0000-0000-0000-000000000005', '__REPAIR_TEST_E__', '__REPAIR_TEST_E__');

  insert into public.pair_sessions(
    id, study_version_id, status, disconnected_attempt_id, disconnect_detected_at
  ) values
    (v_old_pair, v_study_id, 'instruction', v_leaver,
      now() - make_interval(secs => v_reconnect_seconds + 1)),
    (v_return_pair, v_study_id, 'instruction', v_returning,
      now() - make_interval(secs => v_reconnect_seconds + 1));

  insert into public.attempts(
    id, participant_code_id, auth_user_id, study_version_id, pair_session_id, stage, last_seen_at
  ) values
    (v_leaver, '40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', v_study_id, v_old_pair, 'instruction', now() - make_interval(secs => v_reconnect_seconds + 20)),
    (v_survivor, '40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', v_study_id, v_old_pair, 'instruction', now()),
    (v_waiter, '40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000003', v_study_id, null, 'waiting', now()),
    (v_returning, '40000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000004', v_study_id, v_return_pair, 'instruction', now()),
    (v_return_partner, '40000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000005', v_study_id, v_return_pair, 'instruction', now());

  update private.participant_codes pc
  set status = 'active', current_attempt_id = a.id
  from public.attempts a where a.participant_code_id = pc.id;

  insert into public.pair_members(pair_session_id, attempt_id, alias) values
    (v_old_pair, v_leaver, 'Amber Finch'),
    (v_old_pair, v_survivor, 'Blue Otter'),
    (v_return_pair, v_returning, 'Cedar Fox'),
    (v_return_pair, v_return_partner, 'Coral Wren');

  insert into public.queue_entries(attempt_id, study_version_id, status, expires_at)
  values (v_waiter, v_study_id, 'waiting', now() + interval '10 minutes');

  perform public.cleanup_assessment();

  select status into v_status from public.pair_sessions where id = v_old_pair;
  if v_status <> 'aborted' then raise exception 'abandoned instruction pair was not aborted'; end if;

  select stage into v_stage from public.attempts where id = v_leaver;
  if v_stage <> 'aborted' then raise exception 'departed participant was not aborted'; end if;

  select pair_session_id into v_new_pair from public.attempts where id = v_survivor;
  if v_new_pair is null or v_new_pair = v_old_pair then
    raise exception 'active participant was not re-paired';
  end if;

  select count(*) into v_count
  from public.attempts
  where id in (v_survivor, v_waiter) and pair_session_id = v_new_pair and stage = 'instruction';
  if v_count <> 2 then raise exception 'new pair does not contain survivor and waiter'; end if;

  select count(*) into v_count from public.pair_members where pair_session_id = v_old_pair;
  if v_count <> 1 then raise exception 'survivor remained bound to abandoned pair'; end if;

  select status into v_status from public.pair_sessions where id = v_return_pair;
  if v_status <> 'instruction' then raise exception 'returning participant pair was incorrectly aborted'; end if;

  select count(*) into v_count from public.pair_sessions
  where id = v_return_pair and disconnected_attempt_id is null and disconnect_detected_at is null;
  if v_count <> 1 then raise exception 'returning participant disconnect marker was not cleared'; end if;
end;
$$;

rollback;
