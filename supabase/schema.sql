-- pet-breath-log database (final state of the applied migrations).
-- Run in a new Supabase project: SQL editor → paste → run.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default '我家',
  invite_code text unique not null default upper(substr(encode(extensions.gen_random_bytes(6),'hex'),1,8)),
  created_at timestamptz not null default now()
);

create table public.members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index members_user_idx on public.members(user_id);

create table public.pets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  warn_yellow int not null default 26 check (warn_yellow between 5 and 150),
  warn_red int not null default 30 check (warn_red between 5 and 150),
  vet_name text not null default '' check (char_length(vet_name) <= 80),
  vet_phone text not null default '' check (char_length(vet_phone) <= 30),
  created_at timestamptz not null default now(),
  check (warn_yellow <= warn_red)
);
create index pets_household_idx on public.pets(household_id);

create table public.records (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  ts timestamptz not null default now(),
  rpm int not null check (rpm between 5 and 150),
  method text not null default 'manual' check (method in ('30s','60s','manual','siri','import')),
  count int,
  dur int,
  asleep boolean not null default true,
  note text not null default '' check (char_length(note) <= 200),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index records_pet_ts_idx on public.records(pet_id, ts desc);
create index records_household_idx on public.records(household_id);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  ts timestamptz not null,
  kind text not null default 'other' check (kind in ('med_start','med_change','med_stop','vet','other')),
  label text not null check (char_length(label) between 1 and 60),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index events_pet_ts_idx on public.events(pet_id, ts);

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  label text not null default 'Siri' check (char_length(label) <= 40),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- helpers live in a schema the API does not expose
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_member(hh uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.members m where m.household_id = hh and m.user_id = auth.uid()); $$;
revoke all on function private.is_member(uuid) from public, anon;
grant execute on function private.is_member(uuid) to authenticated;

-- household_id always comes from the pet; signed-in users are always recorded as themselves
create or replace function private.set_household_from_pet()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  select p.household_id into new.household_id from public.pets p where p.id = new.pet_id;
  if new.household_id is null then raise exception 'unknown pet'; end if;
  if tg_op = 'INSERT' and auth.uid() is not null then new.created_by := auth.uid(); end if;
  return new;
end $$;
revoke all on function private.set_household_from_pet() from public, anon, authenticated;
create trigger records_set_hh before insert or update of pet_id on public.records for each row execute function private.set_household_from_pet();
create trigger events_set_hh before insert or update of pet_id on public.events for each row execute function private.set_household_from_pet();

alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.pets enable row level security;
alter table public.records enable row level security;
alter table public.events enable row level security;
alter table public.api_tokens enable row level security;

create policy hh_select on public.households for select to authenticated using (private.is_member(id));
create policy hh_update on public.households for update to authenticated using (private.is_member(id)) with check (private.is_member(id));
create policy mem_select on public.members for select to authenticated using (private.is_member(household_id));
create policy mem_update_self on public.members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy pets_select on public.pets for select to authenticated using (private.is_member(household_id));
create policy pets_insert on public.pets for insert to authenticated with check (private.is_member(household_id));
create policy pets_update on public.pets for update to authenticated using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy rec_select on public.records for select to authenticated using (private.is_member(household_id));
create policy rec_insert on public.records for insert to authenticated with check (private.is_member(household_id));
create policy rec_update on public.records for update to authenticated using (created_by = auth.uid()) with check (private.is_member(household_id));
create policy rec_delete on public.records for delete to authenticated using (created_by = auth.uid());
create policy ev_select on public.events for select to authenticated using (private.is_member(household_id));
create policy ev_insert on public.events for insert to authenticated with check (private.is_member(household_id));
create policy ev_update on public.events for update to authenticated using (private.is_member(household_id)) with check (private.is_member(household_id));
create policy ev_delete on public.events for delete to authenticated using (private.is_member(household_id));
create policy tok_select_own on public.api_tokens for select to authenticated using (user_id = auth.uid());
create policy tok_delete_own on public.api_tokens for delete to authenticated using (user_id = auth.uid());

revoke all on public.households, public.members, public.pets, public.records, public.events, public.api_tokens from anon;
revoke insert, update on public.api_tokens from authenticated;

create or replace function public.create_household(p_household_name text, p_pet_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare hh uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'already in a household'; end if;
  insert into public.households(name) values (coalesce(nullif(trim(p_household_name),''),'我家')) returning id into hh;
  insert into public.members(household_id, user_id, display_name) values (hh, auth.uid(), coalesce(trim(p_display_name),''));
  insert into public.pets(household_id, name) values (hh, coalesce(nullif(trim(p_pet_name),''),'猫'));
  return hh;
end $$;

create or replace function public.join_household(p_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare hh uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'already in a household'; end if;
  select id into hh from public.households where invite_code = upper(trim(p_code));
  if hh is null then raise exception 'invalid code'; end if;
  if (select count(*) from public.members where household_id = hh) >= 6 then raise exception 'household full'; end if;
  insert into public.members(household_id, user_id, display_name) values (hh, auth.uid(), coalesce(trim(p_display_name),''));
  return hh;
end $$;

create or replace function public.create_api_token(p_label text)
returns text language plpgsql security definer set search_path = ''
as $$
declare tok text; hh uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select household_id into hh from public.members where user_id = auth.uid() limit 1;
  if hh is null then raise exception 'no household'; end if;
  if (select count(*) from public.api_tokens where user_id = auth.uid()) >= 5 then raise exception 'too many tokens'; end if;
  tok := 'pbl_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.api_tokens(user_id, household_id, label, token_hash)
    values (auth.uid(), hh, coalesce(nullif(trim(p_label), ''), 'Siri'), encode(extensions.digest(tok, 'sha256'), 'hex'));
  return tok;
end $$;

revoke all on function public.create_household(text,text,text) from public, anon;
revoke all on function public.join_household(text,text) from public, anon;
revoke all on function public.create_api_token(text) from public, anon;
grant execute on function public.create_household(text,text,text) to authenticated;
grant execute on function public.join_household(text,text) to authenticated;
grant execute on function public.create_api_token(text) to authenticated;

alter publication supabase_realtime add table public.records, public.events, public.pets;
