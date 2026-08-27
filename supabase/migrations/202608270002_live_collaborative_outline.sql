begin;

create table public.outline_operation_batches (
  id bigint generated always as identity primary key,
  pair_session_id uuid not null references public.pair_sessions(id) on delete cascade,
  sender_attempt_id uuid not null references public.attempts(id) on delete cascade,
  client_batch_id uuid not null,
  operations jsonb not null check (
    jsonb_typeof(operations) = 'array'
    and jsonb_array_length(operations) between 1 and 100
  ),
  created_at timestamptz not null default now(),
  unique (sender_attempt_id, client_batch_id)
);
create index outline_operation_batches_pair_order_idx
  on public.outline_operation_batches(pair_session_id, id);

create table public.outline_documents (
  pair_session_id uuid primary key references public.pair_sessions(id) on delete cascade,
  operation_count bigint not null default 0 check (operation_count >= 0),
  materialized_operation_count bigint not null default 0 check (materialized_operation_count >= 0),
  body text not null default '' check (length(body) <= 20000),
  updated_at timestamptz not null default now()
);

-- Preserve outlines created before live collaboration was introduced as the
-- first immutable operation in their document history.
with seeds as (
  select
    ps.id as pair_session_id,
    coalesce(ps.shared_outline_updated_by, member.attempt_id) as sender_attempt_id,
    ps.shared_outline,
    coalesce(ps.shared_outline_updated_at, ps.phase_started_at, ps.paired_at) as created_at,
    gen_random_uuid() as client_batch_id,
    gen_random_uuid() as operation_id
  from public.pair_sessions ps
  join lateral (
    select pm.attempt_id
    from public.pair_members pm
    where pm.pair_session_id = ps.id
    order by pm.alias
    limit 1
  ) member on true
  where length(ps.shared_outline) > 0
)
insert into public.outline_operation_batches(
  pair_session_id, sender_attempt_id, client_batch_id, operations, created_at
)
select
  pair_session_id,
  sender_attempt_id,
  client_batch_id,
  jsonb_build_array(jsonb_build_object(
    'id', operation_id,
    'insertRuns', jsonb_build_array(jsonb_build_object(
      'id', '000000000001:seed:' || pair_session_id::text,
      'afterId', null,
      'text', shared_outline
    )),
    'deleteIds', '[]'::jsonb
  )),
  created_at
from seeds;

insert into public.outline_documents(
  pair_session_id, operation_count, materialized_operation_count, body, updated_at
)
select
  ps.id,
  coalesce(batch.operation_count, 0),
  coalesce(batch.operation_count, 0),
  ps.shared_outline,
  coalesce(ps.shared_outline_updated_at, ps.phase_started_at, ps.paired_at)
from public.pair_sessions ps
left join lateral (
  select sum(jsonb_array_length(oob.operations))::bigint as operation_count
  from public.outline_operation_batches oob
  where oob.pair_session_id = ps.id
) batch on true;

create or replace function public.append_outline_operation_batches(p_batches jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, auth, realtime
as $$
declare
  v_attempt public.attempts%rowtype;
  v_pair public.pair_sessions%rowtype;
  v_batch jsonb;
  v_operation jsonb;
  v_run jsonb;
  v_delete_id jsonb;
  v_operations jsonb;
  v_batch_operation_count integer;
  v_inserted_operations integer := 0;
  v_inserted_batches integer := 0;
  v_inserted_at timestamptz;
  v_records jsonb := '[]'::jsonb;
  v_operation_count bigint := 0;
begin
  select * into v_attempt from public.attempts where auth_user_id = auth.uid();
  if not found or v_attempt.stage <> 'finalizing' or v_attempt.pair_session_id is null then
    raise exception 'live outline editing is unavailable';
  end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id;
  if not found or v_pair.phase <> 'outline' then raise exception 'live outline editing is unavailable'; end if;
  if jsonb_typeof(p_batches) <> 'array' or jsonb_array_length(p_batches) not between 1 and 10 then
    raise exception 'invalid outline batch request';
  end if;

  for v_batch in select value from jsonb_array_elements(p_batches) loop
    if jsonb_typeof(v_batch) <> 'object' then raise exception 'invalid outline batch'; end if;
    perform (v_batch ->> 'clientBatchId')::uuid;
    v_operations := v_batch -> 'operations';
    if jsonb_typeof(v_operations) <> 'array' or jsonb_array_length(v_operations) not between 1 and 100 then
      raise exception 'invalid outline operations';
    end if;
    v_batch_operation_count := jsonb_array_length(v_operations);

    for v_operation in select value from jsonb_array_elements(v_operations) loop
      if jsonb_typeof(v_operation) <> 'object' then raise exception 'invalid outline operation'; end if;
      perform (v_operation ->> 'id')::uuid;
      if jsonb_typeof(v_operation -> 'insertRuns') <> 'array'
        or jsonb_array_length(v_operation -> 'insertRuns') > 4
        or jsonb_typeof(v_operation -> 'deleteIds') <> 'array'
        or jsonb_array_length(v_operation -> 'deleteIds') > 20000
        or (
          jsonb_array_length(v_operation -> 'insertRuns') = 0
          and jsonb_array_length(v_operation -> 'deleteIds') = 0
        ) then
        raise exception 'invalid outline operation';
      end if;
      for v_run in select value from jsonb_array_elements(v_operation -> 'insertRuns') loop
        if jsonb_typeof(v_run) <> 'object'
          or length(coalesce(v_run ->> 'id', '')) not between 1 and 100
          or length(coalesce(v_run ->> 'text', '')) not between 1 and 20000
          or (
            jsonb_typeof(v_run -> 'afterId') not in ('string', 'null')
            or length(coalesce(v_run ->> 'afterId', '')) > 120
          ) then
          raise exception 'invalid outline insertion';
        end if;
      end loop;
      for v_delete_id in select value from jsonb_array_elements(v_operation -> 'deleteIds') loop
        if jsonb_typeof(v_delete_id) <> 'string' or length(v_delete_id #>> '{}') not between 1 and 120 then
          raise exception 'invalid outline deletion';
        end if;
      end loop;
    end loop;

    v_inserted_at := null;
    insert into public.outline_operation_batches(
      pair_session_id, sender_attempt_id, client_batch_id, operations
    ) values (
      v_pair.id, v_attempt.id, (v_batch ->> 'clientBatchId')::uuid, v_operations
    )
    on conflict (sender_attempt_id, client_batch_id) do nothing
    returning created_at into v_inserted_at;

    if v_inserted_at is not null then
      v_inserted_batches := v_inserted_batches + 1;
      v_inserted_operations := v_inserted_operations + v_batch_operation_count;
      v_records := v_records || jsonb_build_array(jsonb_build_object(
        'clientBatchId', v_batch ->> 'clientBatchId',
        'senderAttemptId', v_attempt.id,
        'operations', v_operations,
        'createdAt', v_inserted_at
      ));
    end if;
  end loop;

  if v_inserted_operations > 0 then
    insert into public.outline_documents(pair_session_id, operation_count)
    values (v_pair.id, v_inserted_operations)
    on conflict (pair_session_id) do update
      set operation_count = public.outline_documents.operation_count + excluded.operation_count,
          updated_at = now()
    returning operation_count into v_operation_count;

    perform realtime.send(
      jsonb_build_object(
        'table', 'outline_operation_batches',
        'operation', 'INSERT',
        'batches', v_records
      ),
      'state_changed',
      'pair:' || v_pair.id::text,
      true
    );
  else
    select operation_count into v_operation_count
    from public.outline_documents where pair_session_id = v_pair.id;
  end if;

  return jsonb_build_object(
    'insertedBatches', v_inserted_batches,
    'insertedOperations', v_inserted_operations,
    'operationCount', coalesce(v_operation_count, 0)
  );
end;
$$;

create or replace function public.save_shared_outline_snapshot(p_body text, p_operation_count bigint)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_attempt public.attempts%rowtype;
  v_pair public.pair_sessions%rowtype;
  v_document public.outline_documents%rowtype;
  v_changed boolean;
begin
  if length(coalesce(p_body, '')) > 20000 then raise exception 'outline is too long'; end if;
  select * into v_attempt from public.attempts where auth_user_id = auth.uid();
  if not found or v_attempt.stage <> 'finalizing' or v_attempt.pair_session_id is null then
    raise exception 'shared outline is unavailable';
  end if;
  select * into v_pair from public.pair_sessions where id = v_attempt.pair_session_id for update;
  if not found or v_pair.phase <> 'outline' then raise exception 'shared outline is unavailable'; end if;

  insert into public.outline_documents(pair_session_id) values (v_pair.id)
  on conflict (pair_session_id) do nothing;
  select * into v_document from public.outline_documents
  where pair_session_id = v_pair.id for update;
  if v_document.operation_count <> p_operation_count then
    raise exception 'outline changed while syncing';
  end if;

  v_changed := v_document.materialized_operation_count <> p_operation_count
    or v_document.body is distinct from coalesce(p_body, '');
  update public.outline_documents
  set body = coalesce(p_body, ''),
      materialized_operation_count = p_operation_count,
      updated_at = now()
  where pair_session_id = v_pair.id;

  if v_changed then
    insert into public.outline_revisions(pair_session_id, editor_attempt_id, body)
    values (v_pair.id, v_attempt.id, coalesce(p_body, ''));
  end if;
  update public.pair_sessions
  set shared_outline = coalesce(p_body, ''),
      shared_outline_updated_at = now(),
      shared_outline_updated_by = v_attempt.id
  where id = v_pair.id;
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
  v_document public.outline_documents%rowtype;
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

  if p_phase = 'outline' then
    insert into public.outline_documents(pair_session_id) values (v_pair.id)
    on conflict (pair_session_id) do nothing;
    select * into v_document from public.outline_documents
    where pair_session_id = v_pair.id for update;
    if v_document.materialized_operation_count <> v_document.operation_count then
      raise exception 'outline changes are still syncing';
    end if;
  end if;

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
      chat_ends_at = case when p_phase = 'ideation' then now() + make_interval(secs => v_duration) else chat_ends_at end,
      shared_outline = case when p_phase = 'outline' then v_document.body else shared_outline end
  where id = v_pair.id and phase = p_phase;
  update public.attempts set stage = v_next_stage where pair_session_id = v_pair.id;
end;
$$;

alter table public.outline_operation_batches enable row level security;
alter table public.outline_documents enable row level security;

create policy outline_operation_batches_read on public.outline_operation_batches
for select to authenticated using (public.is_admin() or public.is_pair_member(pair_session_id));
create policy outline_documents_read on public.outline_documents
for select to authenticated using (public.is_admin() or public.is_pair_member(pair_session_id));

grant select on public.outline_operation_batches, public.outline_documents to authenticated;
revoke all on function public.append_outline_operation_batches(jsonb), public.save_shared_outline_snapshot(text, bigint)
  from public, anon;
grant execute on function public.append_outline_operation_batches(jsonb), public.save_shared_outline_snapshot(text, bigint)
  to authenticated;

commit;
