-- CHIRIPAPP seed v1

-- Categorías
insert into categories (name) values
  ('Hogar y Reparaciones'),
  ('Limpieza y Mantenimiento'),
  ('Movilidad y Asistencia'),
  ('Tecnología y Soporte')
on conflict (name) do nothing;

-- Subcategorías MVP
with c as (select id, name from categories)
insert into subcategories (category_id, name)
select c.id, s.name
from c
join (
  values
    ('Hogar y Reparaciones','Electricista'),
    ('Hogar y Reparaciones','Plomero'),
    ('Hogar y Reparaciones','Pintor'),
    ('Hogar y Reparaciones','Albañil'),
    ('Hogar y Reparaciones','Técnico A/C'),
    ('Hogar y Reparaciones','Cerrajero'),
    ('Limpieza y Mantenimiento','Servicio de limpieza'),
    ('Limpieza y Mantenimiento','Limpieza de sépticos'),
    ('Limpieza y Mantenimiento','Limpiador de cisternas y piscina'),
    ('Movilidad y Asistencia','Gomero'),
    ('Movilidad y Asistencia','Chofer'),
    ('Tecnología y Soporte','Técnico informático')
) as s(category_name, name)
  on s.category_name = c.name
on conflict (category_id, name) do nothing;

-- Zonas Santo Domingo (base)
insert into zones (name, city) values
  ('Distrito Nacional','Santo Domingo'),
  ('Santo Domingo Este','Santo Domingo'),
  ('Santo Domingo Norte','Santo Domingo'),
  ('Santo Domingo Oeste','Santo Domingo'),
  ('Boca Chica','Santo Domingo'),
  ('Los Alcarrizos','Santo Domingo'),
  ('Pedro Brand','Santo Domingo'),
  ('San Antonio de Guerra','Santo Domingo')
on conflict (name) do nothing;

-- Usuario admin demo
insert into users (role, full_name, email, phone, password_hash)
values ('admin','Admin CHIRIPAPP','admin@chiripapp.local','8090000000','demo_hash')
on conflict (email) do nothing;
