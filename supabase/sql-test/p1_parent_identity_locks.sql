-- TEST ONLY (dkqubldmfyeuudecxmvh). Migration name: p1_parent_identity_locks
--
-- P1-2 (whole-backend audit): serialise Parent find-or-create per
-- organisation + authenticated Supabase user. Transitional: the Parent
-- record itself stays in Airtable. Same shape as the existing per-entity
-- locks (cover_date_locks etc.): owner token, stale-lock expiry,
-- service_role-only access. Used by functions-test/parent-hub
-- (parent-identity.ts).
create table if not exists public.parent_identity_locks (
  organisation_id text not null,
  user_id uuid not null,
  lock_token uuid not null,
  locked_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);
alter table public.parent_identity_locks enable row level security;
revoke all on public.parent_identity_locks from anon, authenticated;
grant all on public.parent_identity_locks to service_role;

create or replace function public.acquire_parent_identity_lock(p_organisation_id text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_token uuid;
begin
  if p_organisation_id is null or p_organisation_id = '' or p_user_id is null then
    raise exception 'parent identity lock needs organisation_id and user_id';
  end if;

  delete from parent_identity_locks
   where organisation_id = p_organisation_id
     and user_id = p_user_id
     and locked_at < now() - interval '2 minutes';

  v_token := gen_random_uuid();

  insert into parent_identity_locks (organisation_id, user_id, lock_token, locked_at)
  values (p_organisation_id, p_user_id, v_token, now())
  on conflict (organisation_id, user_id) do nothing;

  if found then
    return v_token;
  else
    return null;
  end if;
end;
$function$;

create or replace function public.release_parent_identity_lock(p_organisation_id text, p_user_id uuid, p_lock_token uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from parent_identity_locks
   where organisation_id = p_organisation_id
     and user_id = p_user_id
     and lock_token = p_lock_token;
  return found;
end;
$function$;

revoke all on function public.acquire_parent_identity_lock(text, uuid) from public, anon, authenticated;
revoke all on function public.release_parent_identity_lock(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acquire_parent_identity_lock(text, uuid) to service_role;
grant execute on function public.release_parent_identity_lock(text, uuid, uuid) to service_role;
