begin;

-- Heartbeats update only last_seen_at. Broadcasting those writes caused every
-- client to refetch its full state even though no participant-visible state
-- had changed.
drop trigger if exists attempts_broadcast on public.attempts;
create trigger attempts_broadcast
after insert or update of stage, pair_session_id, attention_response, completed_at
on public.attempts
for each row execute function public.broadcast_assessment_change();

commit;
