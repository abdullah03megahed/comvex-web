-- =====================================================================
-- COMVEX – Supabase schema v2 (matches the app's real data model)
-- Run this in Supabase -> SQL Editor -> New query -> Run.
-- It REPLACES the 6 tables from the first attempt (they were empty).
-- Your auth user (admin@comvex.local) is kept and gets a profile below.
-- =====================================================================

-- ---------- clean slate ----------
drop trigger if exists on_auth_user_created on auth.users;
drop table if exists public.products, public.factories, public.categories,
                     public.colors, public.sizes, public.profiles cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.is_active() cascade;
drop function if exists public.is_member() cascade;
drop function if exists public.has_perm(text) cascade;
drop function if exists public.assign_row_id() cascade;
drop function if exists public.products_guard() cascade;
drop function if exists public.touch_login() cascade;

-- ---------- profiles (one per login) ----------
-- Login name "ahmed" is stored in Supabase Auth as ahmed@comvex.local.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null,
  role        text not null default 'Viewer'
              check (role in ('Administrator','Manager','Warehouse Employee','Data Entry Employee','Viewer')),
  perms       text[] not null default '{}',
  created_at  timestamptz not null default now(),
  last_login  timestamptz
);
create unique index profiles_username_key on public.profiles (lower(username));

-- ---------- permission helpers ----------
create function public.has_perm(perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'Administrator' or perm = any(p.perms)
                   from public.profiles p where p.id = auth.uid()), false);
$$;

-- "member" = has a profile with at least one permission (blocks stray sign-ups)
create function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'Administrator' or cardinality(p.perms) > 0
                   from public.profiles p where p.id = auth.uid()), false);
$$;

create function public.touch_login()
returns void language sql security definer set search_path = public as $$
  update public.profiles set last_login = now() where id = auth.uid();
$$;

-- next Row ID = max + 1 (same rule as the desktop app); lock prevents races
create function public.assign_row_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.row_id is null then
    perform pg_advisory_xact_lock(hashtext(tg_table_name));
    execute format('select coalesce(max(row_id), 0) + 1 from public.%I', tg_table_name) into new.row_id;
  end if;
  return new;
end $$;

-- ---------- lists: factories / categories / colors / sizes ----------
do $$
declare t text;
begin
  foreach t in array array['factories','categories','colors','sizes'] loop
    execute format('create table public.%I (row_id bigint primary key, name text not null check (length(btrim(name)) > 0))', t);
    execute format('create unique index %I on public.%I (lower(btrim(name)))', t || '_name_key', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.assign_row_id()', t || '_row_id', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member())', t || '_sel', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_perm(''add_list'') or public.has_perm(''import''))', t || '_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.has_perm(''edit_list'')) with check (public.has_perm(''edit_list''))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.has_perm(''delete_list''))', t || '_del', t);
  end loop;
end $$;

-- ---------- products (barcodes) ----------
create table public.products (
  seq           bigint generated always as identity primary key,   -- keeps file/creation order
  barcode       text not null unique,                              -- duplicates are impossible
  factory       text not null default '',
  factory_code  text not null default '',
  category      text not null default '',
  color         text not null default '',
  size          text not null default '',
  date          text not null default '',                          -- "YYYY-MM-DD HH:MM:SS" like Database.xlsx
  asin          text not null default '',
  noon_sku      text not null default '',
  status        text not null default '',                          -- '' or 'Removed'
  removed_date  text not null default ''
);

-- Which columns each permission may change (insurance on top of the app UI)
create function public.products_guard()
returns trigger language plpgsql as $$
begin
  if public.has_perm('import') then return new; end if;

  if (new.barcode, new.factory, new.factory_code, new.category, new.color, new.size, new.date)
     is distinct from
     (old.barcode, old.factory, old.factory_code, old.category, old.color, old.size, old.date) then
    raise exception 'Barcode identity fields cannot be changed.' using errcode = '42501';
  end if;

  if (new.asin, new.noon_sku) is distinct from (old.asin, old.noon_sku)
     and not public.has_perm('edit_product') then
    raise exception 'No permission to edit ASIN / Noon SKU.' using errcode = '42501';
  end if;

  if (new.status, new.removed_date) is distinct from (old.status, old.removed_date) then
    if new.status = 'Removed' then
      if not public.has_perm('remove_product') then
        raise exception 'No permission to remove barcodes.' using errcode = '42501';
      end if;
    elsif not (public.has_perm('remove_product') or public.has_perm('generate')) then
      raise exception 'No permission to restore barcodes.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger products_guard_trg before update on public.products
  for each row execute function public.products_guard();

alter table public.products enable row level security;
create policy products_sel on public.products for select to authenticated using (public.is_member());
create policy products_ins on public.products for insert to authenticated
  with check (public.has_perm('generate') or public.has_perm('import'));
create policy products_upd on public.products for update to authenticated
  using (public.has_perm('edit_product') or public.has_perm('remove_product') or public.has_perm('generate') or public.has_perm('import'))
  with check (public.has_perm('edit_product') or public.has_perm('remove_product') or public.has_perm('generate') or public.has_perm('import'));
-- no delete policy on purpose: barcodes are only ever marked "Removed"

-- ---------- profiles security ----------
alter table public.profiles enable row level security;
create policy profiles_sel on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_perm('manage_users'));
-- no insert/update/delete policies: accounts are changed only by the server (/api/users)

-- ---------- first login becomes Administrator ----------
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, username, role, perms)
  values (
    new.id, lower(split_part(new.email, '@', 1)),
    case when first_user then 'Administrator' else 'Viewer' end,
    case when first_user then array['view_dashboard','view_products','view_lists','generate','edit_product','remove_product','add_list','edit_list','delete_list','export','import','manage_users']
         else '{}'::text[] end
  ) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- profile for the admin you already created
insert into public.profiles (id, username, role, perms)
select id, lower(split_part(email, '@', 1)), 'Administrator',
       array['view_dashboard','view_products','view_lists','generate','edit_product','remove_product','add_list','edit_list','delete_list','export','import','manage_users']
from auth.users where email = 'admin@comvex.local'
on conflict do nothing;

-- ---------- grants ----------
revoke all on public.profiles, public.factories, public.categories, public.colors, public.sizes, public.products from anon, public;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.factories, public.categories, public.colors, public.sizes to authenticated;
grant select, insert, update on public.products to authenticated;

revoke execute on function public.has_perm(text), public.is_member(), public.touch_login() from public, anon;
grant  execute on function public.has_perm(text), public.is_member(), public.touch_login() to authenticated;
