begin;

-- The original schema was installed through the SQL editor, so its migration
-- history did not prove this later trigger optimization had been applied.
-- Reassert it here: last_seen_at heartbeats must not cause full participant
-- state reloads every 20 seconds.
drop trigger if exists attempts_broadcast on public.attempts;
create trigger attempts_broadcast
after insert or update of stage, pair_session_id, attention_response, completed_at
on public.attempts
for each row execute function public.broadcast_assessment_change();

commit;
