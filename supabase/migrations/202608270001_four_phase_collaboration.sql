begin;

alter table public.study_versions
  add column if not exists ideation_instruction_markdown text not null default 'Develop your own ideas independently. Your notes are private and will not be shown to the other participant.',
  add column if not exists ideation_prompt text not null default 'What characters, setting, conflict, and ending could make this story compelling?',
  add column if not exists discussion_instruction_markdown text not null default 'Share and compare ideas with your partner. Ask questions, build on promising details, and identify a direction you both support.',
  add column if not exists discussion_prompt text not null default 'Discuss which ideas should shape the story and why.',
  add column if not exists outline_instruction_markdown text not null default 'Turn your discussion into a shared outline. Agree on the beginning, key events, climax, and ending before moving on.',
  add column if not exists outline_prompt text not null default 'Create a clear shared outline for the final story.',
  add column if not exists writing_instruction_markdown text not null default 'Write the complete story using your shared outline. Either participant may submit a version for both people to review.',
  add column if not exists writing_prompt text not null default 'Write a polished final story with a beginning, middle, and ending.',
  add column if not exists ideation_seconds integer not null default 120,
  add column if not exists discussion_seconds integer not null default 120,
  add column if not exists outline_seconds integer not null default 120,
  add column if not exists writing_seconds integer not null default 120;

alter table public.study_versions
  drop constraint if exists study_versions_ideation_seconds_check,
  drop constraint if exists study_versions_discussion_seconds_check,
  drop constraint if exists study_versions_outline_seconds_check,
  drop constraint if exists study_versions_writing_seconds_check;
alter table public.study_versions
  add constraint study_versions_ideation_seconds_check check (ideation_seconds between 10 and 14400),
  add constraint study_versions_discussion_seconds_check check (discussion_seconds between 10 and 14400),
  add constraint study_versions_outline_seconds_check check (outline_seconds between 10 and 14400),
  add constraint study_versions_writing_seconds_check check (writing_seconds between 10 and 14400);

alter table public.pair_sessions
  add column if not exists phase text not null default 'ideation',
  add column if not exists phase_started_at timestamptz,
  add column if not exists phase_ends_at timestamptz,
  add column if not exists shared_outline text not null default '',
  add column if not exists shared_outline_updated_at timestamptz,
  add column if not exists shared_outline_updated_by uuid references public.attempts(id) on delete set null;

alter table public.pair_sessions drop constraint if exists pair_sessions_phase_check;
alter table public.pair_sessions
  add constraint pair_sessions_phase_check check (phase in ('ideation', 'discussion', 'outline', 'writing'));

update public.pair_sessions
set phase = case
    when status = 'instruction' then 'ideation'
    when status = 'chat' then 'discussion'
    else 'writing'
  end,
  phase_started_at = coalesce(phase_started_at, chat_started_at, paired_at),
  phase_ends_at = coalesce(phase_ends_at, chat_ends_at, paired_at + interval '2 minutes');

alter table public.pair_sessions
  alter column phase_started_at set default now(),
  alter column phase_started_at set not null;

create table if not exists public.ideation_drafts (
  attempt_id uuid primary key references public.attempts(id) on delete cascade,
  pair_session_id uuid references public.pair_sessions(id) on delete set null,
  body text not null default '' check (length(body) <= 20000),
  updated_at timestamptz not null default now()
);

create table if not exists public.pair_phase_approvals (
  pair_session_id uuid not null references public.pair_sessions(id) on delete cascade,
  phase text not null check (phase in ('ideation', 'discussion', 'outline')),
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  decided_at timestamptz not null default now(),
  primary key (pair_session_id, phase, attempt_id)
);
create index if not exists pair_phase_approvals_pair_idx
  on public.pair_phase_approvals(pair_session_id, phase, decided_at);

create table if not exists public.outline_revisions (
  id uuid primary key default gen_random_uuid(),
  pair_session_id uuid not null references public.pair_sessions(id) on delete cascade,
  editor_attempt_id uuid not null references public.attempts(id) on delete cascade,
  body text not null check (length(body) <= 20000),
  created_at timestamptz not null default now()
);
create index if not exists outline_revisions_pair_time_idx
  on public.outline_revisions(pair_session_id, created_at, id);

create or replace function public.get_pair_presence(p_pair_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth
as $$
declare v_phase text;
begin
  if not public.is_pair_member(p_pair_id) and not public.is_admin() then
    raise exception 'pair membership required';
  end if;
  select phase into v_phase from public.pair_sessions where id = p_pair_id;
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
      and (public.is_admin() or v_phase <> 'ideation' or a.auth_user_id = auth.uid())
  ), '[]'::jsonb);
end;
$$;

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
  v_ideation_seconds integer;
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
  select ideation_seconds into v_ideation_seconds
  from public.study_versions where id = v_me.study_version_id;

  insert into public.pair_sessions(study_version_id, phase, phase_started_at, phase_ends_at)
  values (v_me.study_version_id, 'ideation', now(), now() + make_interval(secs => v_ideation_seconds))
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

create or replace function public.save_ideation_draft(p_body text)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare v_attempt public.attempts%rowtype; v_phase text;
begin
  if length(coalesce(p_body, '')) > 20000 then raise exception 'ideation draft is too long'; end if;
  select * into v_attempt from public.attempts where auth_user_id = auth.uid();
  if not found or v_attempt.stage <> 'instruction' or v_attempt.pair_session_id is null then
    raise exception 'private ideation is unavailable';
  end if;
  select phase into v_phase from public.pair_sessions where id = v_attempt.pair_session_id;
  if v_phase <> 'ideation' then raise exception 'private ideation has ended'; end if;
  insert into public.ideation_drafts(attempt_id, pair_session_id, body, updated_at)
  values (v_attempt.id, v_attempt.pair_session_id, coalesce(p_body, ''), now())
  on conflict (attempt_id) do update
    set pair_session_id = excluded.pair_session_id, body = excluded.body, updated_at = now();
end;
$$;

create or replace function public.save_shared_outline(p_body text)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare v_attempt public.attempts%rowtype; v_pair public.pair_sessions%rowtype; v_revision_id uuid;
begin
  if length(coalesce(p_body, '')) > 20000 then raise exception 'outline is too long'; end if;
  select * into v_attempt from public.attempts where auth_user_id = auth.uid();
  if not found or v_attempt.stage <> 'finalizing' or v_attempt.pair_session_id is null then
    raise exception 'shared outline is unavailable';
  end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id for update;
  if v_pair.phase <> 'outline' then raise exception 'shared outline is unavailable'; end if;
  insert into public.outline_revisions(pair_session_id, editor_attempt_id, body)
  values (v_pair.id, v_attempt.id, coalesce(p_body, '')) returning id into v_revision_id;
  update public.pair_sessions
  set shared_outline = coalesce(p_body, ''), shared_outline_updated_at = now(), shared_outline_updated_by = v_attempt.id
  where id = v_pair.id;
  return v_revision_id;
end;
$$;

create or replace function public.approve_phase(p_phase text)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_attempt public.attempts%rowtype;
  v_pair public.pair_sessions%rowtype;
  v_next_phase text;
  v_next_status public.pair_status;
  v_next_stage public.attempt_stage;
  v_duration integer;
begin
  if p_phase not in ('ideation', 'discussion', 'outline') then raise exception 'invalid collaboration phase'; end if;
  select * into v_attempt from public.attempts where auth_user_id = auth.uid() for update;
  if not found or v_attempt.pair_session_id is null or v_attempt.stage not in ('instruction', 'chat', 'finalizing') then
    raise exception 'phase approval is unavailable';
  end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id for update;
  if v_pair.phase <> p_phase then return; end if;
  if v_pair.phase_ends_at is null or now() < v_pair.phase_ends_at then raise exception 'minimum phase time has not ended'; end if;
  if v_pair.disconnected_attempt_id is not null then raise exception 'your partner is reconnecting'; end if;

  insert into public.pair_phase_approvals(pair_session_id, phase, attempt_id)
  values (v_pair.id, p_phase, v_attempt.id)
  on conflict (pair_session_id, phase, attempt_id) do nothing;

  if (select count(*) from public.pair_phase_approvals where pair_session_id = v_pair.id and phase = p_phase) < 2 then
    return;
  end if;

  if p_phase = 'ideation' then
    v_next_phase := 'discussion'; v_next_status := 'chat'; v_next_stage := 'chat';
    select discussion_seconds into v_duration from public.study_versions where id = v_attempt.study_version_id;
  elsif p_phase = 'discussion' then
    v_next_phase := 'outline'; v_next_status := 'finalizing'; v_next_stage := 'finalizing';
    select outline_seconds into v_duration from public.study_versions where id = v_attempt.study_version_id;
  else
    v_next_phase := 'writing'; v_next_status := 'finalizing'; v_next_stage := 'finalizing';
    select writing_seconds into v_duration from public.study_versions where id = v_attempt.study_version_id;
  end if;

  update public.pair_sessions
  set phase = v_next_phase,
      status = v_next_status,
      phase_started_at = now(),
      phase_ends_at = now() + make_interval(secs => v_duration),
      chat_started_at = case when p_phase = 'ideation' then now() else chat_started_at end,
      chat_ends_at = case when p_phase = 'ideation' then now() + make_interval(secs => v_duration) else chat_ends_at end
  where id = v_pair.id and phase = p_phase;
  update public.attempts set stage = v_next_stage where pair_session_id = v_pair.id;
end;
$$;

create or replace function public.mark_ready()
returns void
language plpgsql security definer
set search_path = public, auth
as $$
begin
  perform public.approve_phase('ideation');
end;
$$;

create or replace function public.send_message(
  p_body text, p_client_message_id uuid, p_field_instance_id uuid
)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare v_attempt public.attempts%rowtype; v_pair public.pair_sessions%rowtype; v_id uuid;
begin
  select * into v_attempt from public.attempts where auth_user_id = auth.uid();
  if not found or v_attempt.stage not in ('chat', 'finalizing') then raise exception 'chat is unavailable'; end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id;
  if not found or v_pair.phase not in ('discussion', 'outline', 'writing') then raise exception 'chat is unavailable'; end if;
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
  if not found or v_attempt.stage <> 'finalizing' then raise exception 'story submission unavailable'; end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id for update;
  if v_pair.phase <> 'writing' then raise exception 'final writing phase has not started'; end if;
  if v_pair.phase_ends_at is null or now() < v_pair.phase_ends_at then raise exception 'minimum writing time has not ended'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'story required'; end if;
  update public.story_proposals set status = 'rejected', decided_at = now()
    where pair_session_id = v_pair.id and status = 'pending';
  select coalesce(max(version), 0) + 1 into v_version from public.story_proposals where pair_session_id = v_pair.id;
  insert into public.story_proposals(pair_session_id, proposer_attempt_id, version, body, field_instance_id)
  values (v_pair.id, v_attempt.id, v_version, p_body, p_field_instance_id) returning id into v_id;
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
  v_pair public.pair_sessions%rowtype;
  v_proposal public.story_proposals%rowtype;
begin
  if p_decision not in ('agree', 'disagree') then raise exception 'invalid decision'; end if;
  select * into v_attempt from public.attempts where auth_user_id = auth.uid() for update;
  if not found or v_attempt.stage <> 'finalizing' then raise exception 'invalid attempt stage'; end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id;
  if not found or v_pair.phase <> 'writing' then raise exception 'story approval is unavailable'; end if;
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
    wait_seconds, chat_seconds, reconnect_seconds, quiz_questions, created_by,
    ideation_instruction_markdown, ideation_prompt, discussion_instruction_markdown, discussion_prompt,
    outline_instruction_markdown, outline_prompt, writing_instruction_markdown, writing_prompt,
    ideation_seconds, discussion_seconds, outline_seconds, writing_seconds
  ) values (
    v_version, 'active', p_config ->> 'consentMarkdown', p_config ->> 'keystrokeDisclosure',
    p_config ->> 'attentionPrompt', coalesce(p_config ->> 'instructionMarkdown', p_config ->> 'discussionInstructionMarkdown'),
    (p_config ->> 'waitSeconds')::integer, (p_config ->> 'discussionSeconds')::integer,
    (p_config ->> 'reconnectSeconds')::integer, p_config -> 'quizQuestions', auth.uid(),
    p_config ->> 'ideationInstructionMarkdown', p_config ->> 'ideationPrompt',
    p_config ->> 'discussionInstructionMarkdown', p_config ->> 'discussionPrompt',
    p_config ->> 'outlineInstructionMarkdown', p_config ->> 'outlinePrompt',
    p_config ->> 'writingInstructionMarkdown', p_config ->> 'writingPrompt',
    (p_config ->> 'ideationSeconds')::integer, (p_config ->> 'discussionSeconds')::integer,
    (p_config ->> 'outlineSeconds')::integer, (p_config ->> 'writingSeconds')::integer
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.broadcast_assessment_change()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare v_pair uuid; v_attempt uuid; v_payload jsonb;
begin
  v_payload := jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP);
  if TG_TABLE_NAME = 'attempts' then
    v_attempt := new.id; v_pair := new.pair_session_id;
  elsif TG_TABLE_NAME = 'pair_sessions' then v_pair := new.id;
  elsif TG_TABLE_NAME = 'pair_members' then v_pair := new.pair_session_id; v_attempt := new.attempt_id;
  elsif TG_TABLE_NAME in ('messages', 'story_proposals', 'outline_revisions') then v_pair := new.pair_session_id;
  elsif TG_TABLE_NAME = 'story_approvals' then
    select pair_session_id into v_pair from public.story_proposals where id = new.proposal_id;
  elsif TG_TABLE_NAME = 'pair_phase_approvals' then v_pair := new.pair_session_id; v_attempt := new.attempt_id;
  elsif TG_TABLE_NAME = 'ideation_drafts' then v_attempt := new.attempt_id;
  end if;
  if v_attempt is not null then perform realtime.send(v_payload, 'state_changed', 'attempt:' || v_attempt::text, true); end if;
  if v_pair is not null then perform realtime.send(v_payload, 'state_changed', 'pair:' || v_pair::text, true); end if;
  return new;
end;
$$;

drop trigger if exists ideation_drafts_broadcast on public.ideation_drafts;
create trigger ideation_drafts_broadcast after insert or update on public.ideation_drafts
for each row execute function public.broadcast_assessment_change();
drop trigger if exists phase_approvals_broadcast on public.pair_phase_approvals;
create trigger phase_approvals_broadcast after insert or update on public.pair_phase_approvals
for each row execute function public.broadcast_assessment_change();
drop trigger if exists outline_revisions_broadcast on public.outline_revisions;
create trigger outline_revisions_broadcast after insert on public.outline_revisions
for each row execute function public.broadcast_assessment_change();

alter table public.ideation_drafts enable row level security;
alter table public.pair_phase_approvals enable row level security;
alter table public.outline_revisions enable row level security;

drop policy if exists ideation_drafts_read on public.ideation_drafts;
create policy ideation_drafts_read on public.ideation_drafts for select to authenticated using (
  public.is_admin() or exists (
    select 1 from public.attempts a where a.id = attempt_id and a.auth_user_id = auth.uid()
  )
);
drop policy if exists phase_approvals_read on public.pair_phase_approvals;
create policy phase_approvals_read on public.pair_phase_approvals for select to authenticated using (
  public.is_admin() or (
    public.is_pair_member(pair_session_id)
    and (
      phase <> 'ideation'
      or exists (select 1 from public.attempts a where a.id = attempt_id and a.auth_user_id = auth.uid())
    )
  )
);
drop policy if exists outline_revisions_read on public.outline_revisions;
create policy outline_revisions_read on public.outline_revisions for select to authenticated using (
  public.is_admin() or public.is_pair_member(pair_session_id)
);

drop policy if exists pair_members_read on public.pair_members;
create policy pair_members_read on public.pair_members for select to authenticated using (
  public.is_admin() or (
    public.is_pair_member(pair_session_id)
    and (
      (select ps.phase from public.pair_sessions ps where ps.id = pair_session_id) <> 'ideation'
      or exists (select 1 from public.attempts a where a.id = attempt_id and a.auth_user_id = auth.uid())
    )
  )
);

grant select on public.ideation_drafts, public.pair_phase_approvals, public.outline_revisions to authenticated;
revoke all on function public.save_ideation_draft(text), public.save_shared_outline(text), public.approve_phase(text) from public, anon;
grant execute on function public.save_ideation_draft(text), public.save_shared_outline(text), public.approve_phase(text) to authenticated;

commit;
