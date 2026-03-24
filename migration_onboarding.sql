-- CHIRIPAPP DB hardening migration
-- Date: 2026-03-13

begin;

-- 1) verification_notes: text -> jsonb (safe cast)
alter table chiripero_profiles
  alter column verification_notes type jsonb
  using (
    case
      when verification_notes is null or btrim(verification_notes) = '' then '{}'::jsonb
      when left(btrim(verification_notes),1) in ('{','[') then verification_notes::jsonb
      else jsonb_build_object('legacy_note', verification_notes)
    end
  );

alter table chiripero_profiles
  alter column verification_notes set default '{}'::jsonb;

-- 2) onboarding progress tracking
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_stage') THEN
    CREATE TYPE onboarding_stage AS ENUM ('registro','anuncio','membresia_pago','en_revision','completado');
  END IF;
END $$;

create table if not exists onboarding_progress (
  id uuid primary key default gen_random_uuid(),
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  stage onboarding_stage not null,
  status text not null default 'done',
  note text null,
  actor text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_onboarding_progress_profile_created
  on onboarding_progress(chiripero_profile_id, created_at desc);

-- 4) membership payments history
create table if not exists membership_payments (
  id uuid primary key default gen_random_uuid(),
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  plan_code text not null,
  amount numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0,
  amount_final numeric(12,2) not null,
  payment_method text not null,
  payment_reference text not null,
  proof_url text null,
  status text not null default 'submitted',
  reviewed_by text null,
  reviewed_note text null,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz null
);

create index if not exists idx_membership_payments_profile_submitted
  on membership_payments(chiripero_profile_id, submitted_at desc);

-- 5) promo redemptions audit
create table if not exists promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  code text not null references promo_codes(code),
  chiripero_profile_id uuid not null references chiripero_profiles(id) on delete cascade,
  membership_payment_id uuid null references membership_payments(id) on delete set null,
  discount_percent numeric(7,2) not null,
  discount_amount numeric(12,2) not null,
  redeemed_at timestamptz not null default now()
);

create index if not exists idx_promo_redemptions_profile_time
  on promo_redemptions(chiripero_profile_id, redeemed_at desc);

commit;
