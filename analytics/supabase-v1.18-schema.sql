-- Run manually in the Supabase SQL Editor before enabling DocSync v1.18 roles.
-- This is deliberately separate from the desktop application: role authority
-- stays in Supabase and no service-role credential is bundled with DocSync.

create table if not exists public.user_roles (
    user_id uuid primary key references auth.users(id) on delete cascade,
    role text not null check (role in ('user', 'admin')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;
revoke all on public.user_roles from anon;
revoke insert, update, delete on public.user_roles from authenticated;
grant select on public.user_roles to authenticated;

drop policy if exists user_roles_select_own on public.user_roles;
create policy user_roles_select_own on public.user_roles
for select to authenticated using (auth.uid() = user_id);

create or replace function public.set_user_roles_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists user_roles_set_updated_at on public.user_roles;
create trigger user_roles_set_updated_at before update on public.user_roles
for each row execute function public.set_user_roles_updated_at();

-- Keep the existing profile trigger and atomically create the safe default role.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(user_id,display_name,avatar_url)
  values(new.id,coalesce(new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name'),new.raw_user_meta_data->>'avatar_url')
  on conflict(user_id) do nothing;
  insert into public.user_roles(user_id,role) values(new.id,'user') on conflict(user_id) do nothing;
  return new;
end;
$$;

-- Existing users receive the least-privileged role once; this never promotes anyone.
insert into public.user_roles(user_id, role)
select id, 'user' from auth.users on conflict(user_id) do nothing;

-- Promote a known user only from the Supabase SQL Editor or a service-role tool:
-- update public.user_roles set role = 'admin' where user_id = '<known-user-uuid>'::uuid;
