begin;
select plan(18);

select has_table('public', 'attempts');
select has_table('public', 'queue_entries');
select has_table('public', 'pair_sessions');
select has_table('public', 'pair_members');
select has_table('public', 'messages');
select has_table('public', 'story_proposals');
select has_table('public', 'story_approvals');
select has_table('public', 'quiz_responses');
select has_table('public', 'integrity_events');
select has_table('public', 'keystroke_events');
select has_function('public', 'join_waiting_room', array[]::text[]);
select has_function('public', 'mark_ready', array[]::text[]);
select has_function('public', 'send_message', array['text','uuid','uuid']);
select has_function('public', 'propose_story', array['text','uuid']);
select has_function('public', 'decide_story', array['uuid','text']);
select has_function('public', 'append_keystroke_batch', array['jsonb']);
select has_function('public', 'cleanup_assessment', array[]::text[]);
select results_eq(
  $$select count(*)::bigint from public.study_versions where status = 'active'$$,
  array[1::bigint],
  'exactly one active seed study exists'
);

select * from finish();
rollback;
