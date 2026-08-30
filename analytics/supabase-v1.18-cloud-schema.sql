-- Run manually in the Supabase SQL Editor after supabase-v1.18-schema.sql.
-- The desktop app uses only the authenticated user's JWT and the RLS policies below.
insert into storage.buckets (id, name, public) values ('docsync-workspaces', 'docsync-workspaces', false) on conflict (id) do update set public = false;

create table if not exists public.devices (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  display_name text, first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), app_version text
);
create table if not exists public.workspace_snapshots (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete restrict,
  storage_provider text not null check (storage_provider = 'supabase'), storage_bucket text not null check (storage_bucket = 'docsync-workspaces'),
  storage_object_key text not null unique check (storage_object_key ~ '^users/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/snapshots/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.zip$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), archive_size_bytes bigint not null check (archive_size_bytes > 0), workspace_revision bigint not null check (workspace_revision > 0),
  base_snapshot_id uuid, status text not null check (status in ('pending','uploaded','current','superseded','failed','conflict')),
  docsync_version text, database_schema_version integer check (database_schema_version >= 0), created_at timestamptz not null default now(), completed_at timestamptz
);
create table if not exists public.workspace_heads (
  user_id uuid primary key references auth.users(id) on delete cascade, snapshot_id uuid not null references public.workspace_snapshots(id) on delete restrict,
  workspace_revision bigint not null check (workspace_revision > 0), updated_at timestamptz not null default now()
);
create index if not exists workspace_snapshots_user_created_idx on public.workspace_snapshots(user_id, created_at desc);
create index if not exists workspace_snapshots_user_status_idx on public.workspace_snapshots(user_id, status);

alter table public.devices enable row level security; alter table public.workspace_snapshots enable row level security; alter table public.workspace_heads enable row level security;
revoke all on public.devices, public.workspace_snapshots, public.workspace_heads from anon;
grant select, insert, update on public.devices to authenticated; grant select, insert, update on public.workspace_snapshots to authenticated; grant select on public.workspace_heads to authenticated;
drop policy if exists devices_own on public.devices; create policy devices_own on public.devices for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists snapshots_select_own on public.workspace_snapshots; create policy snapshots_select_own on public.workspace_snapshots for select to authenticated using (user_id = auth.uid());
drop policy if exists snapshots_insert_own on public.workspace_snapshots; create policy snapshots_insert_own on public.workspace_snapshots for insert to authenticated with check (user_id = auth.uid() and storage_object_key = 'users/' || auth.uid()::text || '/snapshots/' || id::text || '.zip' and status = 'pending');
drop policy if exists snapshots_update_own on public.workspace_snapshots; create policy snapshots_update_own on public.workspace_snapshots for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and status in ('pending','uploaded','failed','conflict'));
drop policy if exists heads_select_own on public.workspace_heads; create policy heads_select_own on public.workspace_heads for select to authenticated using (user_id = auth.uid());

drop policy if exists docsync_objects_select on storage.objects; create policy docsync_objects_select on storage.objects for select to authenticated using (bucket_id = 'docsync-workspaces' and split_part(name,'/',1) = 'users' and split_part(name,'/',2) = auth.uid()::text);
drop policy if exists docsync_objects_insert on storage.objects; create policy docsync_objects_insert on storage.objects for insert to authenticated with check (bucket_id = 'docsync-workspaces' and split_part(name,'/',1) = 'users' and split_part(name,'/',2) = auth.uid()::text);
drop policy if exists docsync_objects_update on storage.objects; create policy docsync_objects_update on storage.objects for update to authenticated using (bucket_id = 'docsync-workspaces' and split_part(name,'/',1) = 'users' and split_part(name,'/',2) = auth.uid()::text) with check (bucket_id = 'docsync-workspaces' and split_part(name,'/',1) = 'users' and split_part(name,'/',2) = auth.uid()::text);
drop policy if exists docsync_objects_delete on storage.objects; create policy docsync_objects_delete on storage.objects for delete to authenticated using (bucket_id = 'docsync-workspaces' and split_part(name,'/',1) = 'users' and split_part(name,'/',2) = auth.uid()::text);

create or replace function public.promote_workspace_snapshot(p_snapshot_id uuid, p_expected_base_snapshot_id uuid, p_expected_base_revision bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid(); v_snapshot public.workspace_snapshots%rowtype; v_head public.workspace_heads%rowtype; v_next_revision bigint;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select * into v_snapshot from public.workspace_snapshots where id = p_snapshot_id and user_id = v_user for update;
  if not found or v_snapshot.status <> 'uploaded' then raise exception 'snapshot_not_promotable'; end if;
  select * into v_head from public.workspace_heads where user_id = v_user for update;
  if found then
    if v_head.snapshot_id is distinct from p_expected_base_snapshot_id or v_head.workspace_revision <> p_expected_base_revision then return jsonb_build_object('status','conflict','current_snapshot_id',v_head.snapshot_id,'current_revision',v_head.workspace_revision); end if;
    v_next_revision := v_head.workspace_revision + 1; update public.workspace_snapshots set status = 'superseded' where id = v_head.snapshot_id and user_id = v_user;
  else
    if p_expected_base_snapshot_id is not null or p_expected_base_revision <> 0 then return jsonb_build_object('status','conflict','current_snapshot_id',null,'current_revision',0); end if;
    v_next_revision := 1;
  end if;
  update public.workspace_snapshots set status = 'current', workspace_revision = v_next_revision, completed_at = coalesce(completed_at, now()) where id = p_snapshot_id and user_id = v_user;
  insert into public.workspace_heads(user_id,snapshot_id,workspace_revision,updated_at) values(v_user,p_snapshot_id,v_next_revision,now()) on conflict(user_id) do update set snapshot_id=excluded.snapshot_id, workspace_revision=excluded.workspace_revision, updated_at=excluded.updated_at;
  return jsonb_build_object('status','current','snapshot_id',p_snapshot_id,'workspace_revision',v_next_revision);
end;
$$;
revoke all on function public.promote_workspace_snapshot(uuid,uuid,bigint) from public; grant execute on function public.promote_workspace_snapshot(uuid,uuid,bigint) to authenticated;
