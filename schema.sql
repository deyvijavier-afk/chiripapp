-- CHIRIPAPP DB Schema v1
-- PostgreSQL / Supabase compatible

create extension if not exists "pgcrypto";

do $$ begin
  create type user_role as enum ('client','chiripero','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type profile_status as enum ('pending','approved','rejected','suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type membership_status as enum ('active','grace','inactive');
exception when duplicate_object then null; end $$;

do $$ begin
  create type membership_plan as enum ('weekly_500','monthly_1500');
exception when duplicate_object then null; end $$;

do $$ begin
  create type media_type as enum ('image','video');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contact_type as enum ('whatsapp_tap','call_tap');
exception when duplicate_object then null; end $$;

do $$ begin
  create type report_status as enum ('open','reviewing','resolved','dismissed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_provider as enum ('manual','azul');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('pending','paid','failed','refunded');
exception when duplicate_object then null; end $$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  role user_role not null,
  full_name text not null,
  phone text,
  email text unique,
  password_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chiripero_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  display_name text not null,
  bio text,
  cedula_or_id text,
  status profile_status not null default 'pending',
  membership_status membership_status not null default 'inactive',
  membership_plan membership_plan,
  membership_expires_at timestamptz,
  whatsapp_number text,
  call_number text,
  rating_avg numeric(3,2) not null default 0,
  rating_count int not null default 0,
  cedula_number text,
  verification_notes text,
  documents_status text not null default 'pending',
  documents_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(category_id, name)
);

create table if not exists chiripero_services (
  id uuid primary key default gen_random_uuid(),
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  subcategory_id uuid not null references subcategories(id) on delete restrict,
  years_experience int,
  base_price_note text,
  created_at timestamptz not null default now(),
  unique(chiripero_profile_id, subcategory_id)
);

create table if not exists zones (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  city text not null default 'Santo Domingo',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists chiripero_zones (
  id uuid primary key default gen_random_uuid(),
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  zone_id uuid not null references zones(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(chiripero_profile_id, zone_id)
);

create table if not exists chiripero_media (
  id uuid primary key default gen_random_uuid(),
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  media_url text not null,
  media_type media_type not null,
  created_at timestamptz not null default now()
);

create table if not exists favorites (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references users(id) on delete cascade,
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(client_user_id, chiripero_profile_id)
);

create table if not exists contact_events (
  id uuid primary key default gen_random_uuid(),
  client_user_id uuid references users(id) on delete set null,
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  type contact_type not null,
  created_at timestamptz not null default now()
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_user_id uuid references users(id) on delete set null,
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  reason text not null,
  status report_status not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  plan membership_plan not null,
  amount numeric(10,2) not null,
  currency text not null default 'DOP',
  payment_provider payment_provider not null default 'manual',
  payment_status payment_status not null default 'pending',
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists promo_codes (
  id serial primary key,
  code text unique not null,
  discount_percent numeric(5,2) not null default 0,
  active boolean not null default true,
  expires_at timestamptz,
  max_uses int,
  times_used int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists chiripero_documents (
  id uuid primary key default gen_random_uuid(),
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  doc_type text not null check (doc_type in ('cedula_front','buena_conducta')),
  file_url text not null,
  ocr_json jsonb,
  uploaded_at timestamptz not null default now(),
  review_status text not null default 'pending' check (review_status in ('pending','approved','rejected')),
  review_notes text
);

create index if not exists idx_profiles_status_membership on chiripero_profiles(status, membership_status);
create index if not exists idx_profiles_membership_exp on chiripero_profiles(membership_expires_at);
create index if not exists idx_services_subcategory on chiripero_services(subcategory_id);
create index if not exists idx_zones_zone on chiripero_zones(zone_id);
create index if not exists idx_contact_events_profile_date on contact_events(chiripero_profile_id, created_at desc);
create index if not exists idx_memberships_profile_status on memberships(chiripero_profile_id, payment_status);
create index if not exists idx_chiripero_docs_profile on chiripero_documents(chiripero_profile_id, doc_type);

alter table chiripero_profiles add column if not exists cedula_number text;
alter table chiripero_profiles add column if not exists verification_notes text;
alter table chiripero_profiles add column if not exists documents_status text not null default 'pending';
alter table chiripero_profiles add column if not exists documents_reviewed_at timestamptz;
