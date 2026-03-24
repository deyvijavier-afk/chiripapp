-- Demo chiriperos data

with z as (
  select id, name from zones
), s as (
  select sc.id, sc.name from subcategories sc
), ins_users as (
  insert into users (role, full_name, phone, email, password_hash)
  values
    ('chiripero','José Electric','8091110001','jose.electric@demo.local','demo_hash'),
    ('chiripero','María Plomería','8091110002','maria.plomeria@demo.local','demo_hash'),
    ('chiripero','Kelvin Limpieza','8091110003','kelvin.limpieza@demo.local','demo_hash'),
    ('chiripero','Andrés Pintura','8091110004','andres.pintura@demo.local','demo_hash'),
    ('chiripero','Rafael AC','8091110005','rafael.ac@demo.local','demo_hash')
  on conflict (email) do update set full_name=excluded.full_name
  returning id, full_name, phone, email
)
insert into chiripero_profiles (
  user_id, display_name, bio, status, membership_status, membership_plan, membership_expires_at,
  whatsapp_number, call_number, rating_avg, rating_count
)
select
  u.id,
  u.full_name,
  case
    when u.full_name='José Electric' then 'Electricista residencial y comercial con 8 años de experiencia.'
    when u.full_name='María Plomería' then 'Destapes, fugas y reparación de bombas de agua.'
    when u.full_name='Kelvin Limpieza' then 'Limpieza profunda de hogares y oficinas.'
    when u.full_name='Andrés Pintura' then 'Pintura interior/exterior y resane profesional.'
    else 'Instalación y mantenimiento de aires acondicionados split.'
  end,
  'approved',
  'active',
  'monthly_1500',
  now() + interval '30 days',
  u.phone,
  u.phone,
  (4 + random())::numeric(3,2),
  (20 + floor(random()*80))::int
from ins_users u
on conflict (user_id) do update
set status='approved', membership_status='active', membership_plan='monthly_1500', membership_expires_at=now()+interval '30 days';

-- Servicios por perfil
insert into chiripero_services (chiripero_profile_id, subcategory_id, years_experience, base_price_note)
select cp.id, sc.id,
  case
    when sc.name='Electricista' then 8
    when sc.name='Plomero' then 6
    when sc.name='Servicio de limpieza' then 5
    when sc.name='Pintor' then 7
    when sc.name='Técnico A/C' then 9
    else 3
  end,
  'Precio se acuerda según visita y trabajo.'
from chiripero_profiles cp
join users u on u.id = cp.user_id
join subcategories sc on (
  (u.email='jose.electric@demo.local' and sc.name='Electricista') or
  (u.email='maria.plomeria@demo.local' and sc.name='Plomero') or
  (u.email='kelvin.limpieza@demo.local' and sc.name='Servicio de limpieza') or
  (u.email='andres.pintura@demo.local' and sc.name='Pintor') or
  (u.email='rafael.ac@demo.local' and sc.name='Técnico A/C')
)
on conflict (chiripero_profile_id, subcategory_id) do nothing;

-- Zonas (cobertura)
insert into chiripero_zones (chiripero_profile_id, zone_id)
select cp.id, z.id
from chiripero_profiles cp
join users u on u.id = cp.user_id
join zones z on z.name in ('Distrito Nacional','Santo Domingo Este')
where u.email in ('jose.electric@demo.local','maria.plomeria@demo.local','andres.pintura@demo.local')
on conflict (chiripero_profile_id, zone_id) do nothing;

insert into chiripero_zones (chiripero_profile_id, zone_id)
select cp.id, z.id
from chiripero_profiles cp
join users u on u.id = cp.user_id
join zones z on z.name in ('Santo Domingo Norte','Santo Domingo Oeste')
where u.email in ('kelvin.limpieza@demo.local','rafael.ac@demo.local')
on conflict (chiripero_profile_id, zone_id) do nothing;
