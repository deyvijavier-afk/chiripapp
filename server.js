require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const db = require('./db');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

async function callVision(imageBase64, prompt) {
  const apiKey = process.env.VISION_API_KEY;
  const model = process.env.VISION_MODEL || 'gpt-4o-mini';
  const baseUrl = process.env.VISION_BASE_URL || 'https://api.openai.com/v1';

  if (!apiKey) throw new Error('vision_api_key_missing');

  const body = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}` } }
        ]
      }
    ]
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || 'vision_api_error');
  return data?.choices?.[0]?.message?.content || '';
}

async function visionExtractCedula(imageBase64) {
  const prompt = `Extrae SOLO JSON válido de una cédula dominicana (si algún campo no aparece, null).\nCampos exactos:\n{\n  "first_name": string|null,\n  "last_name": string|null,\n  "full_name": string|null,\n  "cedula_number": string|null,\n  "birth_date": string|null,\n  "birth_place": string|null,\n  "nationality": string|null,\n  "sex": string|null,\n  "blood_type": string|null,\n  "civil_status": string|null,\n  "occupation": string|null,\n  "expires_at": string|null\n}\nReglas:\n- cédula formato ###-#######-#\n- fechas en YYYY-MM-DD cuando sea posible.`;

  const text = await callVision(imageBase64, prompt);
  const cleaned = String(text).replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error('vision_json_parse_failed'); }

  const fields = Array.isArray(parsed) ? (parsed[0] || {}) : (parsed || {});
  const contract = {
    first_name: fields?.first_name ?? null,
    last_name: fields?.last_name ?? null,
    full_name: fields?.full_name ?? null,
    cedula_number: fields?.cedula_number ?? null,
    birth_date: fields?.birth_date ?? null,
    birth_place: fields?.birth_place ?? null,
    nationality: fields?.nationality ?? null,
    sex: fields?.sex ?? null,
    blood_type: fields?.blood_type ?? null,
    civil_status: fields?.civil_status ?? null,
    occupation: fields?.occupation ?? null,
    expires_at: fields?.expires_at ?? null,
  };

  return { fields: contract, raw: cleaned };
}

const app = express();
const uploadsRoot = path.join(__dirname, 'public', 'uploads');
const chiriperoBannerDir = path.join(uploadsRoot, 'chiriperos', 'banners');
fs.mkdirSync(chiriperoBannerDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.use('/demo', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsRoot));
app.get('/', (_req, res) => res.redirect('/demo/index.html'));

app.get('/health', async (_req, res) => {
  try {
    const r = await db.query('select now() as now');
    res.json({ ok: true, time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/categorias', async (_req, res) => {
  try {
    const q = `
      select c.id, c.name,
        coalesce(json_agg(json_build_object('id', s.id, 'name', s.name) order by s.name)
          filter (where s.id is not null), '[]') as subcategories
      from categories c
      left join subcategories s on s.category_id = c.id and s.is_active = true
      where c.is_active = true
      group by c.id, c.name
      order by c.name;
    `;
    const r = await db.query(q);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/zonas', async (_req, res) => {
  try {
    const r = await db.query(
      `select id, name, city from zones where is_active=true order by name`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function extractCedula(text) {
  const m = text.match(/\b\d{3}[- ]?\d{7}[- ]?\d\b/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  return `${digits.slice(0,3)}-${digits.slice(3,10)}-${digits.slice(10)}`;
}

function normalizeDateParts(day, month, year) {
  const mm = {
    ENE:'01', FEB:'02', MAR:'03', ABR:'04', MAY:'05', JUN:'06',
    JUL:'07', AGO:'08', SEP:'09', OCT:'10', NOV:'11', DIC:'12'
  }[month?.toUpperCase()];
  if (!mm) return null;
  const dd = String(day).padStart(2, '0');
  const yyyy = String(year).length === 2 ? `19${year}` : String(year);
  return `${yyyy}-${mm}-${dd}`;
}

function extractBirthDateSpanish(text) {
  const m = text.match(/(\d{1,2})\s+([A-ZÁÉÍÓÚ]{3})\s+(\d{2,4})/i);
  if (!m) return null;
  return normalizeDateParts(m[1], m[2], m[3]);
}

function cleanPersonLine(v) {
  return (v || '')
    .toUpperCase()
    .replace(/[^A-ZÁÉÍÓÚÑ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNames(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let first = null;
  let last = null;
  let full = null;

  for (const line of lines) {
    const up = cleanPersonLine(line);
    if (!up) continue;
    if (/REPUBLICA|DOMINICANA|CEDULA|JUNTA|ELECTORAL|IDENTIDAD|NACIONALIDAD|SEXO|SANGRE|OCUPACION|ESTADO|CIVIL|FECHA|NACIMIENTO|EXPIRA|VENCE|DIRECCION/.test(up)) continue;
    const parts = up.split(' ').filter(Boolean);
    if (parts.length >= 2 && parts.length <= 5) {
      full = parts.join(' ');
      first = parts[0] || null;
      last = parts.slice(1).join(' ') || null;
      break;
    }
  }

  if (!first || !last) {
    const candidates = lines
      .map(cleanPersonLine)
      .filter((l) => l && l.split(' ').length >= 2 && l.split(' ').length <= 5)
      .filter((l) => !/REPUBLICA|DOMINICANA|CEDULA|JUNTA|ELECTORAL/.test(l));
    if (candidates.length) {
      full = candidates[0];
      const parts = full.split(' ');
      first = parts[0] || null;
      last = parts.slice(1).join(' ') || null;
    }
  }

  return { first_name: first, last_name: last, full_name: full };
}

function extractLabeledValue(text, regex) {
  const m = String(text || '').match(regex);
  return m ? m[1].trim() : null;
}

function parseVisionTextToFields(rawText) {
  const upper = String(rawText || '').toUpperCase();
  const names = extractNames(rawText);
  const cedula_number = extractCedula(upper);
  const birth_date = extractBirthDateSpanish(upper);
  const nationality = extractLabeledValue(upper, /NACIONALIDAD[:\s]+([^\n]+)/i) || (/REPUBLICA\s+DOMINICANA|REPÚBLICA\s+DOMINICANA/.test(upper) ? 'REPUBLICA DOMINICANA' : null);
  const sex = extractLabeledValue(upper, /SEXO[:\s]+([^\n]+)/i);
  const blood_type = extractLabeledValue(upper, /SANGRE[:\s]+([^\n]+)/i);
  const civil_status = extractLabeledValue(upper, /ESTADO\s+CIVIL[:\s]+([^\n]+)/i);
  const occupation = extractLabeledValue(upper, /OCUPACION[:\s]+([^\n]+)/i);
  const expires_at = extractBirthDateSpanish(extractLabeledValue(upper, /VENCE[:\s]+([^\n]+)/i) || '');

  return {
    ...names,
    cedula_number,
    birth_date,
    birth_place: null,
    nationality,
    sex,
    blood_type,
    civil_status,
    occupation,
    expires_at,
  };
}

async function visionExtractCedulaViaText(imageBase64) {
  const prompt = `Transcribe de forma literal TODO el texto visible de la cédula dominicana.\n- Devuelve SOLO texto plano (sin JSON, sin markdown).\n- Respeta saltos de línea cuando sea posible.`;
  const raw = await callVision(imageBase64, prompt);
  const fields = parseVisionTextToFields(raw);
  return { fields, raw: String(raw || '') };
}

app.post('/ai/extract-cedula', async (req, res) => {
  try {
    const { imageBase64, mode } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'image_required' });

    let result;
    if (mode === 'text') result = await visionExtractCedulaViaText(imageBase64);
    else result = await visionExtractCedula(imageBase64);

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/chiriperos', async (req, res) => {
  try {
    const { subcategory_id, zone_id, q } = req.query || {};
    const vals = [];
    const filters = [`p.status = 'approved'`];

    if (subcategory_id) {
      vals.push(subcategory_id);
      filters.push(`exists (
        select 1 from chiripero_services csf
        where csf.chiripero_profile_id = p.id and csf.subcategory_id = $${vals.length}
      )`);
    }

    if (zone_id) {
      vals.push(zone_id);
      filters.push(`exists (
        select 1 from chiripero_zones czf
        where czf.chiripero_profile_id = p.id and czf.zone_id = $${vals.length}
      )`);
    }

    if (q) {
      vals.push(`%${String(q).trim()}%`);
      const idx = vals.length;
      filters.push(`(
        p.display_name ilike $${idx}
        or coalesce(p.bio, '') ilike $${idx}
        or u.full_name ilike $${idx}
        or exists (
          select 1 from chiripero_services csq
          join subcategories sq on sq.id = csq.subcategory_id
          where csq.chiripero_profile_id = p.id and sq.name ilike $${idx}
        )
        or exists (
          select 1 from chiripero_zones czq
          join zones zq on zq.id = czq.zone_id
          where czq.chiripero_profile_id = p.id and zq.name ilike $${idx}
        )
      )`);
    }

    const qSql = `
      select p.id, p.display_name, p.bio, p.avatar_url, p.ad_banner_url, p.ad_text,
             p.membership_status, p.status, p.rating_avg, p.rating_count,
             p.whatsapp_number, p.call_number,
             u.full_name, u.phone,
             coalesce((
               select json_agg(distinct jsonb_build_object('id', s.id, 'name', s.name) order by jsonb_build_object('id', s.id, 'name', s.name))
               from chiripero_services cs
               join subcategories s on s.id = cs.subcategory_id
               where cs.chiripero_profile_id = p.id
             ), '[]') as services,
             coalesce((
               select json_agg(distinct jsonb_build_object('id', z.id, 'name', z.name, 'city', z.city) order by jsonb_build_object('id', z.id, 'name', z.name, 'city', z.city))
               from chiripero_zones cz
               join zones z on z.id = cz.zone_id
               where cz.chiripero_profile_id = p.id
             ), '[]') as zones,
             (
               select s2.name
               from chiripero_services cs2
               join subcategories s2 on s2.id = cs2.subcategory_id
               where cs2.chiripero_profile_id = p.id
               order by s2.name asc
               limit 1
             ) as primary_service
      from chiripero_profiles p
      join users u on u.id = p.user_id
      where ${filters.join(' and ')}
      order by p.created_at desc
    `;
    const r = await db.query(qSql, vals);
    res.json(r.rows.map(row => ({
      ...row,
      whatsapp_number: row.whatsapp_number || row.phone,
      call_number: row.call_number || row.phone,
      primary_service: row.primary_service || (row.services?.[0]?.name ?? null)
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/chiriperos/:id', async (req, res) => {
  try {
    const r = await db.query(`
      select p.*, u.full_name, u.phone, u.email,
        (
          select json_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
          from chiripero_services cs
          join subcategories s on s.id = cs.subcategory_id
          where cs.chiripero_profile_id = p.id
        ) as services,
        (
          select json_agg(jsonb_build_object('id', z.id, 'name', z.name, 'city', z.city) order by z.name)
          from chiripero_zones cz
          join zones z on z.id = cz.zone_id
          where cz.chiripero_profile_id = p.id
        ) as zones,
        '[]'::json as documents
      from chiripero_profiles p
      join users u on u.id = p.user_id
      where p.id = $1
    `, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({
      ...r.rows[0],
      whatsapp_number: r.rows[0].whatsapp_number || r.rows[0].phone,
      call_number: r.rows[0].call_number || r.rows[0].phone
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/chiriperos', async (_req, res) => {
  try {
    const r = await db.query(`
      select p.id, p.status, p.membership_status, p.created_at,
             p.display_name, p.bio, p.cedula_number,
             u.full_name, u.phone, u.email,
             (
               select json_agg(jsonb_build_object(
                 'doc_type', d.doc_type,
                 'file_url', d.file_url,
                 'review_status', d.review_status,
                 'uploaded_at', d.uploaded_at
               ) order by d.uploaded_at desc)
               from chiripero_documents d where d.profile_id = p.id
             ) as documents,
             (
               select count(*) from chiripero_documents d where d.profile_id = p.id
             ) as docs_count
      from chiripero_profiles p
      join users u on u.id = p.user_id
      order by p.created_at desc
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/chiriperos/:id/decision', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { decision, notes } = req.body || {};
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    await client.query('begin');
    const newStatus = decision === 'approved' ? 'active' : 'rejected';
    await client.query(
      `update chiripero_profiles set status=$1, verification_notes=$2, updated_at=now() where id=$3`,
      [newStatus, notes || null, req.params.id]
    );
    await client.query(
      `update chiripero_documents set review_status=$1 where profile_id=$2 and review_status='pending'`,
      [decision, req.params.id]
    );
    await client.query('commit');
    res.json({ ok: true, status: newStatus });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/chiriperos/register', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const {
      full_name, phone, email,
      display_name, bio,
      cedula_number,
      services = [], zones = [],
      docs = []
    } = req.body || {};

    if (!full_name || !phone) return res.status(400).json({ error: 'missing_required_fields' });

    await client.query('begin');
    const userInsert = await client.query(
      `insert into users (role, full_name, phone, email)
       values ('chiripero', $1, $2, $3)
       returning id`,
      [full_name.trim(), String(phone).replace(/\D/g,'').slice(-10), email || null]
    );
    const userId = userInsert.rows[0].id;

    const profileInsert = await client.query(
      `insert into chiripero_profiles (user_id, display_name, bio, cedula_number, status, membership_status)
       values ($1, $2, $3, $4, 'pending', 'inactive')
       returning id`,
      [userId, display_name || full_name.trim(), bio || null, cedula_number || null]
    );
    const profileId = profileInsert.rows[0].id;

    for (const subcategoryId of services) {
      await client.query(
        `insert into chiripero_subcategories (profile_id, subcategory_id) values ($1, $2) on conflict do nothing`,
        [profileId, subcategoryId]
      );
    }

    for (const zoneId of zones) {
      await client.query(
        `insert into chiripero_zones (profile_id, zone_id) values ($1, $2) on conflict do nothing`,
        [profileId, zoneId]
      );
    }

    for (const doc of docs) {
      await client.query(
        `insert into chiripero_documents (profile_id, doc_type, file_url, review_status)
         values ($1, $2, $3, 'pending')`,
        [profileId, doc.doc_type, doc.file_url]
      );
    }

    await client.query('commit');
    res.json({ ok: true, profile_id: profileId });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/chiriperos/:id/ad-setup', async (req, res) => {
  try {
    const { ad_text, ad_banner_type = 'generic', ad_banner_url = null } = req.body || {};
    const r = await db.query(
      `update chiripero_profiles
       set ad_text=$1, ad_banner_type=$2, ad_banner_url=$3, updated_at=now()
       where id=$4
       returning id, ad_text, ad_banner_type, ad_banner_url`,
      [ad_text || null, ad_banner_type, ad_banner_url, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function ensurePromoCatalog() {
  try {
    await db.query(`
      create table if not exists promo_codes (
        id serial primary key,
        code text unique not null,
        discount_percent numeric(5,2) not null default 0,
        active boolean not null default true,
        created_at timestamptz not null default now()
      );
    `);
    const exists = await db.query(`select 1 from promo_codes where code='AIREFINO10' limit 1`);
    if (!exists.rowCount) {
      await db.query(`insert into promo_codes (code, discount_percent, active) values ('AIREFINO10', 10, true)`);
    }
    console.log('promo_catalog OK');
  } catch (e) {
    console.error('promo_catalog_err', e.message);
  }
}

app.get('/membership/plans', async (_req, res) => {
  res.json([
    { id: 'weekly', name: 'Semanal', price: 300, duration_days: 7 },
    { id: 'monthly', name: 'Mensual', price: 1000, duration_days: 30 },
    { id: 'quarterly', name: 'Trimestral', price: 2500, duration_days: 90 },
  ]);
});

app.post('/chiriperos/:id/membership-submit', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { plan_id, payment_method, payment_reference, proof_url, promo_code } = req.body || {};
    if (!plan_id || !payment_method || !payment_reference || !proof_url) return res.status(400).json({ error: 'missing_fields' });

    let price = 0;
    let durationDays = 0;
    if (plan_id === 'weekly') { price = 300; durationDays = 7; }
    else if (plan_id === 'monthly') { price = 1000; durationDays = 30; }
    else if (plan_id === 'quarterly') { price = 2500; durationDays = 90; }
    else return res.status(400).json({ error: 'invalid_plan' });

    let discountPercent = 0;
    if (promo_code) {
      const promo = await client.query(`select discount_percent from promo_codes where code=$1 and active=true`, [String(promo_code).trim().toUpperCase()]);
      if (promo.rowCount) discountPercent = Number(promo.rows[0].discount_percent || 0);
    }
    const finalPrice = Math.max(0, price - (price * discountPercent / 100));

    await client.query('begin');
    const r = await client.query(
      `insert into memberships (profile_id, plan_id, status, payment_method, payment_reference, proof_url, amount_paid, duration_days)
       values ($1, $2, 'pending', $3, $4, $5, $6, $7)
       returning id, status`,
      [req.params.id, plan_id, payment_method, payment_reference, proof_url, finalPrice, durationDays]
    );
    await client.query('commit');
    res.json({ ok: true, membership: r.rows[0], final_price: finalPrice, discount_percent: discountPercent });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/admin/memberships/pending', async (_req, res) => {
  try {
    const r = await db.query(`
      select m.*, p.display_name, u.full_name, u.phone
      from memberships m
      join chiripero_profiles p on p.id = m.profile_id
      join users u on u.id = p.user_id
      where m.status = 'pending'
      order by m.created_at desc
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/memberships/:id/decision', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { decision } = req.body || {};
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    await client.query('begin');
    const membershipQ = await client.query(`select * from memberships where id=$1`, [req.params.id]);
    if (!membershipQ.rowCount) {
      await client.query('rollback');
      return res.status(404).json({ error: 'not_found' });
    }
    const membership = membershipQ.rows[0];
    await client.query(`update memberships set status=$1, reviewed_at=now() where id=$2`, [decision, req.params.id]);
    if (decision === 'approved') {
      await client.query(
        `update chiripero_profiles
         set membership_status='active', membership_expires_at=now() + ($1 || ' days')::interval, updated_at=now()
         where id=$2`,
        [String(membership.duration_days || 30), membership.profile_id]
      );
    }
    await client.query('commit');
    res.json({ ok: true });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/chiriperos/:id/onboarding-stage', async (req, res) => {
  try {
    const { stage } = req.body || {};
    await db.query(`update chiripero_profiles set onboarding_stage=$1, updated_at=now() where id=$2`, [stage || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/contact-events', async (req, res) => {
  try {
    const { profile_id, channel, target, source } = req.body || {};
    await db.query(
      `insert into contact_events (profile_id, channel, target, source) values ($1, $2, $3, $4)`,
      [profile_id || null, channel || null, target || null, source || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN CATÁLOGO: CATEGORÍAS =====
app.get('/admin/catalogo/categorias', async (_req, res) => {
  try {
    const r = await db.query(`
      select c.id, c.name, c.is_active,
        coalesce(json_agg(jsonb_build_object('id', s.id, 'name', s.name, 'is_active', s.is_active) order by s.name)
          filter (where s.id is not null), '[]') as subcategories
      from categories c
      left join subcategories s on s.category_id = c.id
      group by c.id, c.name, c.is_active
      order by c.name
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/catalogo/categorias', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });
    const r = await db.query(`insert into categories (name, is_active) values ($1, true) returning *`, [name.trim()]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/catalogo/categorias/:id', async (req, res) => {
  try {
    const { name, is_active } = req.body || {};
    const updates = [];
    const vals = [];
    if (name !== undefined) { vals.push(name.trim()); updates.push(`name=$${vals.length}`); }
    if (is_active !== undefined) { vals.push(!!is_active); updates.push(`is_active=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
    vals.push(req.params.id);
    const r = await db.query(`update categories set ${updates.join(', ')} where id=$${vals.length} returning *`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/catalogo/categorias/:id', async (req, res) => {
  try {
    const r = await db.query(`delete from categories where id=$1 returning id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'categoria_en_uso', message: 'Esta categoría tiene servicios activos asignados a chiriperos.' });
    res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN CATÁLOGO: SUBCATEGORÍAS (SERVICIOS) =====
app.post('/admin/catalogo/subcategorias', async (req, res) => {
  try {
    const { category_id, name } = req.body || {};
    if (!category_id || !name) return res.status(400).json({ error: 'missing_fields' });
    const r = await db.query(
      `insert into subcategories (category_id, name, is_active) values ($1, $2, true) returning *`,
      [category_id, name.trim()]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/catalogo/subcategorias/:id', async (req, res) => {
  try {
    const { category_id, name, is_active } = req.body || {};
    const updates = [];
    const vals = [];
    if (category_id !== undefined) { vals.push(category_id); updates.push(`category_id=$${vals.length}`); }
    if (name !== undefined) { vals.push(name.trim()); updates.push(`name=$${vals.length}`); }
    if (is_active !== undefined) { vals.push(!!is_active); updates.push(`is_active=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
    vals.push(req.params.id);
    const r = await db.query(`update subcategories set ${updates.join(', ')} where id=$${vals.length} returning *`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/catalogo/subcategorias/:id', async (req, res) => {
  try {
    const r = await db.query(`delete from subcategories where id=$1 returning id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'servicio_en_uso', message: 'Este servicio está asignado a uno o más chiriperos.' });
    res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN CATÁLOGO: ZONAS =====
app.get('/admin/catalogo/zonas', async (_req, res) => {
  try {
    const r = await db.query(`select * from zones order by name`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/catalogo/zonas', async (req, res) => {
  try {
    const { name, city } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });
    const r = await db.query(`insert into zones (name, city, is_active) values ($1, $2, true) returning *`, [name.trim(), city || null]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/catalogo/zonas/:id', async (req, res) => {
  try {
    const { name, city, is_active } = req.body || {};
    const updates = [];
    const vals = [];
    if (name !== undefined) { vals.push(name.trim()); updates.push(`name=$${vals.length}`); }
    if (city !== undefined) { vals.push(city); updates.push(`city=$${vals.length}`); }
    if (is_active !== undefined) { vals.push(!!is_active); updates.push(`is_active=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
    vals.push(req.params.id);
    const r = await db.query(`update zones set ${updates.join(', ')} where id=$${vals.length} returning *`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/catalogo/zonas/:id', async (req, res) => {
  try {
    const r = await db.query(`delete from zones where id=$1 returning id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'zona_en_uso', message: 'Esta zona está asignada a uno o más chiriperos.' });
    res.status(500).json({ error: e.message });
  }
});
// ===== FIN ADMIN CATÁLOGO =====

app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'image_too_large', message: 'La imagen es demasiado pesada. Intenta con una foto más liviana.' });
  }
  if (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
  next();
});

// ===== PORTAL CHIRIPERO =====

async function ensureChiriperoPortalColumns() {
  try {
    await db.query(`
      alter table users add column if not exists username text unique;
      alter table chiripero_profiles add column if not exists avatar_url text;
      alter table chiripero_profiles add column if not exists ad_banner_url text;
      alter table chiripero_profiles add column if not exists ad_text text;
      alter table chiripero_profiles add column if not exists ad_banner_type text not null default 'generic';
    `);
    console.log('chiripero_portal_columns OK');
  } catch(e) {
    console.error('chiripero_portal_columns_err', e.message);
  }
}

app.post('/chiripero/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing_credentials' });
    const r = await db.query(
      `select u.id as user_id, u.full_name, u.phone, u.email, u.username, u.password_hash,
              p.id as profile_id, p.display_name, p.status, p.membership_status,
              p.membership_expires_at, p.whatsapp_number, p.call_number,
              p.avatar_url, p.ad_banner_url, p.ad_text, p.ad_banner_type,
              p.bio, p.cedula_number, p.verification_notes
       from users u
       join chiripero_profiles p on p.user_id = u.id
       where u.username = $1 and u.role = 'chiripero'`,
      [username.trim().toLowerCase()]
    );
    if (!r.rowCount) return res.status(401).json({ error: 'invalid_credentials' });
    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'invalid_credentials' });
    const { password_hash, ...safe } = user;
    res.json({ ok: true, chiripero: safe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/chiripero/:profileId/me', async (req, res) => {
  try {
    const r = await db.query(
      `select u.id as user_id, u.full_name, u.phone, u.email, u.username,
              p.id as profile_id, p.display_name, p.status, p.membership_status,
              p.membership_expires_at, p.whatsapp_number, p.call_number,
              p.avatar_url, p.ad_banner_url, p.ad_text, p.ad_banner_type,
              p.bio, p.cedula_number, p.verification_notes
       from users u
       join chiripero_profiles p on p.user_id = u.id
       where p.id = $1`,
      [req.params.profileId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/chiripero/:profileId/perfil', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { display_name, phone, whatsapp_number, call_number, bio, avatar_url } = req.body || {};
    const profUpdates = [];
    const profVals = [];
    if (display_name !== undefined) { profVals.push(display_name.trim()); profUpdates.push(`display_name=$${profVals.length}`); }
    if (whatsapp_number !== undefined) { profVals.push(String(whatsapp_number).replace(/\D/g,'').slice(-10)); profUpdates.push(`whatsapp_number=$${profVals.length}`); }
    if (call_number !== undefined) { profVals.push(String(call_number).replace(/\D/g,'').slice(-10)); profUpdates.push(`call_number=$${profVals.length}`); }
    if (bio !== undefined) { profVals.push(bio.trim()); profUpdates.push(`bio=$${profVals.length}`); }
    if (avatar_url !== undefined) { profVals.push(avatar_url); profUpdates.push(`avatar_url=$${profVals.length}`); }
    if (profUpdates.length) {
      profVals.push(req.params.profileId);
      await client.query(`update chiripero_profiles set ${profUpdates.join(',')}, updated_at=now() where id=$${profVals.length}`, profVals);
    }
    if (phone !== undefined) {
      const normalizedPhone = String(phone).replace(/\D/g,'').slice(-10);
      const userQ = await client.query(`select user_id from chiripero_profiles where id=$1`, [req.params.profileId]);
      if (userQ.rowCount) {
        await client.query(`update users set phone=$1, updated_at=now() where id=$2`, [normalizedPhone, userQ.rows[0].user_id]);
      }
    }
    await client.query('commit');
    res.json({ ok: true });
  } catch(e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.patch('/chiripero/:profileId/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return res.status(400).json({ error: 'missing_fields' });
    if (new_password.length < 4) return res.status(400).json({ error: 'password_too_short' });
    const userQ = await db.query(`select u.id, u.password_hash from users u join chiripero_profiles p on p.user_id=u.id where p.id=$1`, [req.params.profileId]);
    if (!userQ.rowCount) return res.status(404).json({ error: 'not_found' });
    const valid = await bcrypt.compare(current_password, userQ.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'wrong_current_password' });
    const hash = await bcrypt.hash(new_password, 10);
    await db.query(`update users set password_hash=$1, updated_at=now() where id=$2`, [hash, userQ.rows[0].id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/chiripero/:profileId/baja', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password_required' });
    const userQ = await client.query(`select u.id, u.password_hash from users u join chiripero_profiles p on p.user_id=u.id where p.id=$1`, [req.params.profileId]);
    if (!userQ.rowCount) return res.status(404).json({ error: 'not_found' });
    const valid = await bcrypt.compare(password, userQ.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'wrong_password' });
    await client.query('begin');
    await client.query(`update chiripero_profiles set status='inactive', membership_status='inactive', updated_at=now() where id=$1`, [req.params.profileId]);
    await client.query(`update users set username=null, updated_at=now() where id=$1`, [userQ.rows[0].id]);
    await client.query('commit');
    res.json({ ok: true, message: 'Cuenta desactivada' });
  } catch(e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/chiripero/:profileId/anuncio/banner', async (req, res) => {
  try {
    const { imageBase64, fileName } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'image_required' });

    const profileCheck = await db.query(`select id from chiripero_profiles where id=$1`, [req.params.profileId]);
    if (!profileCheck.rowCount) return res.status(404).json({ error: 'not_found' });

    const normalized = String(imageBase64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    const inputBuffer = Buffer.from(normalized, 'base64');
    if (!inputBuffer.length) return res.status(400).json({ error: 'invalid_image' });
    if (inputBuffer.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'image_too_large' });

    const safeName = String(fileName || 'banner')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'banner';

    const finalName = `${req.params.profileId}-${Date.now()}-${safeName.replace(/\.[^.]+$/, '')}.webp`;
    const outputPath = path.join(chiriperoBannerDir, finalName);

    await sharp(inputBuffer)
      .rotate()
      .resize({ width: 1400, height: 600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(outputPath);

    const publicUrl = `/uploads/chiriperos/banners/${finalName}`;

    const r = await db.query(
      `update chiripero_profiles
         set ad_banner_type='custom', ad_banner_url=$1, updated_at=now()
       where id=$2
       returning ad_banner_type, ad_banner_url, ad_text`,
      [publicUrl, req.params.profileId]
    );

    res.json({ ok: true, ...r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/chiripero/:profileId/anuncio', async (req, res) => {
  try {
    const { ad_banner_type, ad_banner_url, ad_text } = req.body || {};
    const updates = [];
    const vals = [];
    if (ad_banner_type !== undefined) {
      if (!['generic','custom'].includes(ad_banner_type)) return res.status(400).json({ error: 'invalid_banner_type' });
      vals.push(ad_banner_type); updates.push(`ad_banner_type=$${vals.length}`);
    }
    if (ad_banner_url !== undefined) { vals.push(ad_banner_url); updates.push(`ad_banner_url=$${vals.length}`); }
    if (ad_text !== undefined) { vals.push(ad_text.slice(0,280)); updates.push(`ad_text=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
    vals.push(req.params.profileId);
    const r = await db.query(`update chiripero_profiles set ${updates.join(',')}, updated_at=now() where id=$${vals.length} returning ad_banner_type, ad_banner_url, ad_text`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, ...r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== FIN PORTAL CHIRIPERO =====

app.post('/internal/setup-db', async (req, res) => {
  const secret = req.headers['x-setup-secret'];
  if (secret !== process.env.SETUP_SECRET && secret !== 'chiripapp-setup-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const migPath = path.join(__dirname, 'migration_onboarding.sql');
    const seedPath = path.join(__dirname, 'seed.sql');
    const seed2Path = path.join(__dirname, 'seed_demo_chiriperos.sql');
    const seed3Path = path.join(__dirname, 'seed_more_chiriperos.sql');
    const results = [];
    if (fs.existsSync(schemaPath)) {
      await db.query(fs.readFileSync(schemaPath, 'utf8'));
      results.push('schema.sql OK');
    }
    if (fs.existsSync(migPath)) {
      await db.query(fs.readFileSync(migPath, 'utf8'));
      results.push('migration_onboarding.sql OK');
    }
    if (fs.existsSync(seedPath)) {
      await db.query(fs.readFileSync(seedPath, 'utf8'));
      results.push('seed.sql OK');
    }
    if (fs.existsSync(seed2Path)) {
      await db.query(fs.readFileSync(seed2Path, 'utf8'));
      results.push('seed_demo_chiriperos.sql OK');
    }
    if (fs.existsSync(seed3Path)) {
      await db.query(fs.readFileSync(seed3Path, 'utf8'));
      results.push('seed_more_chiriperos.sql OK');
    }
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/internal/set-chiripero-credentials', async (req, res) => {
  const secret = req.headers['x-setup-secret'];
  if (secret !== process.env.SETUP_SECRET && secret !== 'chiripapp-setup-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const { profile_id, username, password, status, membership_status, display_name, bio, ad_text } = req.body || {};
    if (!profile_id || !username || !password) return res.status(400).json({ error: 'missing_fields' });
    const pwd_hash = await bcrypt.hash(password, 10);
    await db.query(
      `UPDATE users SET username=$1, password_hash=$2, updated_at=now()
       WHERE id=(SELECT user_id FROM chiripero_profiles WHERE id=$3)`,
      [username, pwd_hash, profile_id]
    );
    const updates = [];
    const vals = [];
    if (status) { vals.push(status); updates.push(`status=$${vals.length}`); }
    if (membership_status) { vals.push(membership_status); updates.push(`membership_status=$${vals.length}`); }
    if (display_name) { vals.push(display_name); updates.push(`display_name=$${vals.length}`); }
    if (bio) { vals.push(bio); updates.push(`bio=$${vals.length}`); }
    if (ad_text) { vals.push(ad_text); updates.push(`ad_text=$${vals.length}`); }
    if (membership_status === 'active') {
      updates.push(`membership_expires_at=now() + interval '30 days'`);
    }
    if (updates.length) {
      vals.push(profile_id);
      await db.query(`UPDATE chiripero_profiles SET ${updates.join(',')}, updated_at=now() WHERE id=$${vals.length}`, vals);
    }
    res.json({ ok: true, profile_id, username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const port = process.env.PORT || 8088;
Promise.allSettled([ensurePromoCatalog(), ensureChiriperoPortalColumns()])
  .then(() => {
    app.listen(port, () => {
      console.log(`CHIRIPAPP backend running on :${port}`);
    });
  });
