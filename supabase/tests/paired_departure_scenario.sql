begin;

do $$
declare
  v_study_id uuid;
  v_reconnect_seconds integer;
  v_timeout_pair uuid := '50000000-0000-0000-0000-000000000001';
  v_return_pair uuid := '50000000-0000-0000-0000-000000000002';
  v_timeout_leaver uuid := '60000000-0000-0000-0000-000000000001';
  v_timeout_partner uuid := '60000000-0000-0000-0000-000000000002';
  v_returning uuid := '60000000-0000-0000-0000-000000000003';
  v_return_partner uuid := '60000000-0000-0000-0000-000000000004';
  v_status public.pair_status;
  v_count integer;
begin
  select id, reconnect_seconds into v_study_id, v_reconnect_seconds
  from public.study_versions where status = 'active';

  insert into auth.users(id, is_anonymous) values
    ('70000000-0000-0000-0000-000000000001', true),
    ('70000000-0000-0000-0000-000000000002', true),
    ('70000000-0000-0000-0000-000000000003', true),
    ('70000000-0000-0000-0000-000000000004', true);

  insert into private.participant_codes(id, code_normalized, code_display) values
    ('80000000-0000-0000-0000-000000000001', '__PAIR_LEAVE_TEST_A__', '__PAIR_LEAVE_TEST_A__'),
    ('80000000-0000-0000-0000-000000000002', '__PAIR_LEAVE_TEST_B__', '__PAIR_LEAVE_TEST_B__'),
    ('80000000-0000-0000-0000-000000000003', '__PAIR_LEAVE_TEST_C__', '__PAIR_LEAVE_TEST_C__'),
    ('80000000-0000-0000-0000-000000000004', '__PAIR_LEAVE_TEST_D__', '__PAIR_LEAVE_TEST_D__');

  insert into public.pair_sessions(
    id, study_version_id, status, chat_started_at, chat_ends_at,
    disconnected_attempt_id, disconnect_detected_at
  ) values
    (v_timeout_pair, v_study_id, 'chat', now() - interval '1 minute', now() + interval '19 minutes',
      v_timeout_leaver, now() - make_interval(secs => v_reconnect_seconds + 1)),
    (v_return_pair, v_study_id, 'chat', now() - interval '1 minute', now() + interval '19 minutes',
      v_returning, now() - make_interval(secs => v_reconnect_seconds + 1));

  insert into public.attempts(
    id, participant_code_id, auth_user_id, study_version_id, pair_session_id, stage, last_seen_at
  ) values
    (v_timeout_leaver, '80000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', v_study_id, v_timeout_pair, 'chat', now() - make_interval(secs => v_reconnect_seconds + 20)),
    (v_timeout_partner, '80000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', v_study_id, v_timeout_pair, 'chat', now()),
    (v_returning, '80000000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000003', v_study_id, v_return_pair, 'chat', now()),
    (v_return_partner, '80000000-0000-0000-0000-000000000004', '70000000-0000-0000-0000-000000000004', v_study_id, v_return_pair, 'chat', now());

  insert into public.pair_members(pair_session_id, attempt_id, alias, ready_at) values
    (v_timeout_pair, v_timeout_leaver, 'Amber Finch', now()),
    (v_timeout_pair, v_timeout_partner, 'Blue Otter', now()),
    (v_return_pair, v_returning, 'Cedar Fox', now()),
    (v_return_pair, v_return_partner, 'Coral Wren', now());

  perform public.cleanup_assessment();

  select status into v_status from public.pair_sessions where id = v_timeout_pair;
  if v_status <> 'aborted' then raise exception 'timed-out chat pair was not aborted'; end if;

  select count(*) into v_count from public.attempts
  where pair_session_id = v_timeout_pair and stage = 'aborted';
  if v_count <> 2 then raise exception 'timed-out chat attempts were not aborted'; end if;

  select status into v_status from public.pair_sessions where id = v_return_pair;
  if v_status <> 'chat' then raise exception 'returning chat pair was incorrectly aborted'; end if;

  select count(*) into v_count from public.pair_sessions
  where id = v_return_pair and disconnected_attempt_id is null and disconnect_detected_at is null;
  if v_count <> 1 then raise exception 'returning chat marker was not cleared'; end if;
end;
$$;

rollback;
