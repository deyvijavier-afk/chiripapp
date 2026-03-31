-- Seed adicional: 2+ chiriperos por tipo de servicio

drop table if exists tmp_seed_chiriperos;
create temporary table tmp_seed_chiriperos (
  full_name text,
  email text,
  phone text,
  service_name text,
  bio text
);

insert into tmp_seed_chiriperos (full_name,email,phone,service_name,bio) values
  ('Luis Voltio','luis.voltio@demo.local','8092010001','Electricista','Instalaciones eléctricas residenciales y comerciales.'),
  ('Pedro Cable','pedro.cable@demo.local','8092010002','Electricista','Reparación de averías y paneles eléctricos.'),
  ('Ana Tubería','ana.tuberia@demo.local','8092010003','Plomero','Destapes, fugas y reparación de tuberías.'),
  ('Carlos Llave','carlos.llave@demo.local','8092010004','Plomero','Bombas de agua, inodoros y plomería general.'),
  ('Rosa Brillo','rosa.brillo@demo.local','8092010005','Servicio de limpieza','Limpieza profunda de casas y apartamentos.'),
  ('Yolanda Shine','yolanda.shine@demo.local','8092010006','Servicio de limpieza','Limpieza de oficinas y mantenimiento semanal.'),
  ('Manuel Séptico','manuel.septico@demo.local','8092010007','Limpieza de sépticos','Limpieza y mantenimiento de sépticos.'),
  ('Junior Séptico','junior.septico@demo.local','8092010008','Limpieza de sépticos','Servicio rápido de sépticos en SD.'),
  ('Pool Master RD','pool.master@demo.local','8092010009','Limpiador de cisternas y piscina','Limpieza de cisternas, piscinas y tratamiento básico.'),
  ('Aqua Clean','aqua.clean@demo.local','8092010010','Limpiador de cisternas y piscina','Mantenimiento de piscina y desinfección de cisternas.'),
  ('Benny Color','benny.color@demo.local','8092010011','Pintor','Pintura interior y exterior con terminación fina.'),
  ('Mateo Brocha','mateo.brocha@demo.local','8092010012','Pintor','Resane, pintura y sellado de paredes.'),
  ('Ramon Block','ramon.block@demo.local','8092010013','Albañil','Construcción liviana y reparaciones de estructura.'),
  ('Eliezer Obra','eliezer.obra@demo.local','8092010014','Albañil','Pañete, pisos y trabajos de albañilería.'),
  ('Frío Express','frio.express@demo.local','8092010015','Técnico A/C','Instalación y mantenimiento de aire acondicionado.'),
  ('Aire Fino','aire.fino@demo.local','8092010016','Técnico A/C','Limpieza de evaporadores y carga de gas.'),
  ('Goma Plus','goma.plus@demo.local','8092010017','Gomero','Cambio y reparación de neumáticos a domicilio.'),
  ('Rápido Tire','rapido.tire@demo.local','8092010018','Gomero','Parches, aire y balanceo básico.'),
  ('Chofer Seguro','chofer.seguro@demo.local','8092010019','Chofer','Servicio de chofer privado por hora.'),
  ('Ruta VIP','ruta.vip@demo.local','8092010020','Chofer','Traslados ejecutivos y diligencias urbanas.'),
  ('PC Resuelve','pc.resuelve@demo.local','8092010021','Técnico informático','Soporte técnico, redes y formateo de equipos.'),
  ('Tech Barrio','tech.barrio@demo.local','8092010022','Técnico informático','Instalación de impresoras y WiFi doméstico.'),
  ('Clave Total','clave.total@demo.local','8092010023','Cerrajero','Apertura de puertas y cambio de cerraduras.'),
  ('LockPro RD','lockpro.rd@demo.local','8092010024','Cerrajero','Duplicado de llaves y cerrajería residencial.');

insert into users (role, full_name, phone, email, password_hash)
select 'chiripero', t.full_name, t.phone, t.email, 'demo_hash'
from tmp_seed_chiriperos t
on conflict (email) do update set full_name=excluded.full_name, phone=excluded.phone;

insert into chiripero_profiles (
  user_id, display_name, bio, status, membership_status, membership_plan, membership_expires_at,
  whatsapp_number, call_number, rating_avg, rating_count
)
select
  u.id,
  t.full_name,
  t.bio,
  'approved',
  'active',
  'weekly_500',
  now() + interval '14 days',
  t.phone,
  t.phone,
  case t.service_name
    when 'Electricista' then 4.88
    when 'Plomero' then 4.82
    when 'Servicio de limpieza' then 4.79
    when 'Limpieza de sépticos' then 4.73
    when 'Limpiador de cisternas y piscina' then 4.77
    when 'Pintor' then 4.81
    when 'Albañil' then 4.74
    when 'Técnico A/C' then 4.92
    when 'Gomero' then 4.69
    when 'Chofer' then 4.76
    when 'Técnico informático' then 4.84
    when 'Cerrajero' then 4.86
    else 4.70
  end,
  case t.service_name
    when 'Electricista' then 118
    when 'Plomero' then 104
    when 'Servicio de limpieza' then 87
    when 'Limpieza de sépticos' then 52
    when 'Limpiador de cisternas y piscina' then 61
    when 'Pintor' then 79
    when 'Albañil' then 66
    when 'Técnico A/C' then 132
    when 'Gomero' then 48
    when 'Chofer' then 57
    when 'Técnico informático' then 73
    when 'Cerrajero' then 69
    else 40
  end
from tmp_seed_chiriperos t
join users u on u.email=t.email
on conflict (user_id) do update
set status='approved', membership_status='active', membership_plan='weekly_500', membership_expires_at=now()+interval '14 days', bio=excluded.bio;

insert into chiripero_services (chiripero_profile_id, subcategory_id, years_experience, base_price_note)
select cp.id, sc.id, (2 + floor(random()*9))::int, 'Precio se acuerda según visita y trabajo.'
from tmp_seed_chiriperos t
join users u on u.email=t.email
join chiripero_profiles cp on cp.user_id=u.id
join subcategories sc on sc.name=t.service_name
on conflict (chiripero_profile_id, subcategory_id) do nothing;

insert into chiripero_zones (chiripero_profile_id, zone_id)
select cp.id, z.id
from tmp_seed_chiriperos t
join users u on u.email=t.email
join chiripero_profiles cp on cp.user_id=u.id
join lateral (
  select id
  from zones
  where is_active=true
  order by md5(t.email || zones.id::text)
  limit 2
) z on true
on conflict (chiripero_profile_id, zone_id) do nothing;
