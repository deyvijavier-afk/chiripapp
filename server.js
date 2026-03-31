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
const chiriperoDocsDir = path.join(uploadsRoot, 'chiriperos', 'documents');
fs.mkdirSync(chiriperoBannerDir, { recursive: true });
fs.mkdirSync(chiriperoDocsDir, { recursive: true });

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

app.get('/servicios', async (_req, res) => {
  try {
    const r = await db.query(`
      select s.id, s.name, s.category_id, c.name as category_name
      from subcategories s
      join categories c on c.id = s.category_id
      where s.is_active = true and c.is_active = true
      order by s.name
    `);
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
      select p.id, p.status, p.membership_status, p.membership_plan, p.membership_expires_at, p.created_at,
             p.display_name, p.bio, p.cedula_number, p.rating_avg, p.rating_count,
             u.full_name, u.phone, u.email,
             (
               select coalesce(json_agg(jsonb_build_object(
                 'doc_type', d.doc_type,
                 'file_url', d.file_url,
                 'review_status', d.review_status,
                 'uploaded_at', d.uploaded_at
               ) order by d.uploaded_at desc), '[]'::json)
               from chiripero_documents d where d.chiripero_profile_id = p.id
             ) as documents,
             (
               select count(*) from chiripero_documents d where d.chiripero_profile_id = p.id
             ) as docs_count,
             (
               select coalesce(json_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name), '[]'::json)
               from chiripero_services cs
               join subcategories s on s.id = cs.subcategory_id
               where cs.chiripero_profile_id = p.id
             ) as services,
             (
               select coalesce(json_agg(jsonb_build_object('id', z.id, 'name', z.name, 'city', z.city) order by z.name), '[]'::json)
               from chiripero_zones cz
               join zones z on z.id = cz.zone_id
               where cz.chiripero_profile_id = p.id
             ) as zones,
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
      order by p.created_at desc
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/chiriperos/pending', async (_req, res) => {
  try {
    const r = await db.query(`
      select p.id as profile_id, p.display_name, p.cedula_number, p.created_at,
             p.status, p.membership_status,
             p.whatsapp_number, p.call_number,
             coalesce((
               select json_agg(jsonb_build_object(
                 'doc_type', d.doc_type,
                 'file_url', d.file_url,
                 'review_status', d.review_status,
                 'uploaded_at', d.uploaded_at
               ) order by d.uploaded_at desc)
               from chiripero_documents d where d.chiripero_profile_id = p.id
             ), '[]'::json) as documents
      from chiripero_profiles p
      where p.status = 'pending'
      order by p.created_at desc
    `);
    const rows = r.rows.map(row => {
      const documents = Array.isArray(row.documents) ? row.documents : [];
      const pendingDocs = documents.filter(d => String(d.review_status || '').toLowerCase() === 'pending').length;
      const rejectedDocs = documents.filter(d => String(d.review_status || '').toLowerCase() === 'rejected').length;
      const documents_status = rejectedDocs > 0 ? 'rejected' : pendingDocs > 0 ? 'pending' : documents.length ? 'approved' : 'pending';
      return {
        ...row,
        documents,
        documents_status,
        whatsapp_number: row.whatsapp_number || row.call_number || null
      };
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/chiriperos/:id', async (req, res) => {
  try {
    const r = await db.query(`
      select p.id, p.status, p.membership_status, p.membership_plan, p.membership_expires_at,
             p.created_at, p.updated_at, p.display_name, p.bio, p.cedula_number,
             p.rating_avg, p.rating_count, p.whatsapp_number, p.call_number,
             p.verification_notes,
             coalesce((
               select json_agg(jsonb_build_object(
                 'doc_type', d.doc_type,
                 'file_url', d.file_url,
                 'review_status', d.review_status,
                 'review_notes', d.review_notes,
                 'uploaded_at', d.uploaded_at
               ) order by d.uploaded_at desc)
               from chiripero_documents d where d.chiripero_profile_id = p.id
             ), '[]'::json) as documents,
             coalesce((
               select json_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
               from chiripero_services cs
               join subcategories s on s.id = cs.subcategory_id
               where cs.chiripero_profile_id = p.id
             ), '[]'::json) as services,
             coalesce((
               select json_agg(jsonb_build_object('id', z.id, 'name', z.name, 'city', z.city) order by z.name)
               from chiripero_zones cz
               join zones z on z.id = cz.zone_id
               where cz.chiripero_profile_id = p.id
             ), '[]'::json) as zones,
             (
               select s2.name
               from chiripero_services cs2
               join subcategories s2 on s2.id = cs2.subcategory_id
               where cs2.chiripero_profile_id = p.id
               order by s2.name asc
               limit 1
             ) as primary_service
      from chiripero_profiles p
      where p.id = $1
      limit 1
    `, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    const docs = Array.isArray(row.documents) ? row.documents : [];
    const pendingDocs = docs.filter(d => String(d.review_status || '').toLowerCase() === 'pending').length;
    const rejectedDocs = docs.filter(d => String(d.review_status || '').toLowerCase() === 'rejected').length;
    const documents_status = rejectedDocs > 0 ? 'rejected' : pendingDocs > 0 ? 'pending' : docs.length ? 'approved' : 'pending';
    res.json({
      ...row,
      documents: docs,
      services: Array.isArray(row.services) ? row.services : [],
      zones: Array.isArray(row.zones) ? row.zones : [],
      documents_status,
      whatsapp_taps: 0,
      call_taps: 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/chiriperos/:id/decision', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { decision, note, notes } = req.body || {};
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    await client.query('begin');
    const newStatus = decision === 'approved' ? 'approved' : 'rejected';
    await client.query(
      `update chiripero_profiles set status=$1, verification_notes=$2, updated_at=now() where id=$3`,
      [newStatus, note || notes || null, req.params.id]
    );
    await client.query(
      `update chiripero_documents set review_status=$1 where chiripero_profile_id=$2 and review_status='pending'`,
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
      docs = [],
      cedula_file_url,
      cedula_back_file_url,
      buena_conducta_file_url,
      person_photo_url,
      whatsapp,
      address,
      birth_date
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
      `insert into chiripero_profiles (user_id, display_name, bio, cedula_number, status, membership_status, whatsapp_number, call_number)
       values ($1, $2, $3, $4, 'pending', 'inactive', $5, $6)
       returning id`,
      [
        userId,
        display_name || full_name.trim(),
        bio || address || null,
        cedula_number || null,
        whatsapp ? String(whatsapp).replace(/\D/g,'').slice(-10) : String(phone).replace(/\D/g,'').slice(-10),
        String(phone).replace(/\D/g,'').slice(-10)
      ]
    );
    const profileId = profileInsert.rows[0].id;

    for (const subcategoryId of services) {
      await client.query(
        `insert into chiripero_services (chiripero_profile_id, subcategory_id) values ($1, $2) on conflict do nothing`,
        [profileId, subcategoryId]
      );
    }

    for (const zoneId of zones) {
      await client.query(
        `insert into chiripero_zones (chiripero_profile_id, zone_id) values ($1, $2) on conflict do nothing`,
        [profileId, zoneId]
      );
    }

    const normalizedDocs = [
      ...docs,
      ...(cedula_file_url ? [{ doc_type: 'cedula_front', file_url: cedula_file_url }] : []),
      ...(cedula_back_file_url ? [{ doc_type: 'cedula_back', file_url: cedula_back_file_url }] : []),
      ...(buena_conducta_file_url ? [{ doc_type: 'buena_conducta', file_url: buena_conducta_file_url }] : []),
    ];

    for (const doc of normalizedDocs) {
      if (!doc?.doc_type || !doc?.file_url) continue;
      await client.query(
        `insert into chiripero_documents (chiripero_profile_id, doc_type, file_url, review_status)
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

    await db.query(`alter table promo_codes add column if not exists id serial`);
    await db.query(`alter table promo_codes add column if not exists discount_percent numeric(5,2) not null default 0`);
    await db.query(`alter table promo_codes add column if not exists active boolean not null default true`);
    await db.query(`alter table promo_codes add column if not exists expires_at timestamptz`);
    await db.query(`alter table promo_codes add column if not exists max_uses int`);
    await db.query(`alter table promo_codes add column if not exists times_used int not null default 0`);
    await db.query(`alter table promo_codes add column if not exists created_at timestamptz not null default now()`);

    await db.query(`
      do $$
      begin
        if exists (
          select 1
          from information_schema.columns
          where table_name='promo_codes' and column_name='discount_value'
        ) then
          update promo_codes
          set discount_percent = coalesce(discount_percent, discount_value, 0)
          where discount_percent = 0 and discount_value is not null;
        end if;
      end $$;
    `);

    await db.query(`
      do $$
      begin
        if not exists (
          select 1
          from pg_constraint
          where conrelid = 'promo_codes'::regclass
            and contype = 'p'
        ) then
          alter table promo_codes add primary key (id);
        end if;
      exception when others then null;
      end $$;
    `);

    const exists = await db.query(`select 1 from promo_codes where code='AIREFINO10' limit 1`);
    if (!exists.rowCount) {
      await db.query(`
        insert into promo_codes (code, discount_percent, discount_type, discount_value, active)
        values ('AIREFINO10', 10, 'percent', 10, true)
      `);
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

app.get('/promo-codes/validate', async (req, res) => {
  try {
    const { code, amount } = req.query || {};
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return res.json({ valid: false, reason: 'missing_code' });
    const promo = await db.query(
      `select discount_percent, active, expires_at, max_uses, times_used
       from promo_codes
       where code=$1`,
      [normalized]
    );
    if (!promo.rowCount) return res.json({ valid: false, reason: 'not_found' });
    const row = promo.rows[0];
    if (!row.active) return res.json({ valid: false, reason: 'inactive' });
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.json({ valid: false, reason: 'expired' });
    const maxUses = row.max_uses == null ? null : Number(row.max_uses);
    const timesUsed = Number(row.times_used || 0);
    if (maxUses !== null && timesUsed >= maxUses) return res.json({ valid: false, reason: 'usage_limit_reached' });
    const percent = Number(row.discount_percent || 0);
    const amountValue = Number(amount);
    const safeAmount = Number.isNaN(amountValue) ? 0 : amountValue;
    const discountAmount = Math.max(0, safeAmount * percent / 100);
    res.json({
      valid: true,
      percent,
      discountAmount,
      code: normalized,
      expires_at: row.expires_at,
      max_uses: maxUses,
      times_used: timesUsed,
      remaining_uses: maxUses === null ? null : Math.max(0, maxUses - timesUsed)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/chiriperos/:id/membership-submit', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { plan_code, payment_method, payment_reference, proof_url, payment_proof_url, amount, promo_code } = req.body || {};
    const proof = proof_url || payment_proof_url;
    const plan = String(plan_code || '').trim();
    if (!plan || !payment_method || !payment_reference || !proof) return res.status(400).json({ error: 'missing_fields' });

    const planMap = {
      weekly: { amount: 300, days: 7 },
      monthly: { amount: 1000, days: 30 },
      quarterly: { amount: 2500, days: 90 },
    };
    const pickedPlan = planMap[plan];
    if (!pickedPlan) return res.status(400).json({ error: 'invalid_plan' });

    let discountPercent = 0;
    let normalizedPromoCode = null;
    let promoMeta = null;
    if (promo_code) {
      normalizedPromoCode = String(promo_code).trim().toUpperCase();
      const promo = await client.query(
        `select code, discount_percent, active, expires_at, max_uses, times_used
         from promo_codes
         where code=$1`,
        [normalizedPromoCode]
      );
      if (promo.rowCount) {
        const row = promo.rows[0];
        const maxUses = row.max_uses == null ? null : Number(row.max_uses);
        const timesUsed = Number(row.times_used || 0);
        const expired = row.expires_at && new Date(row.expires_at) < new Date();
        const exhausted = maxUses !== null && timesUsed >= maxUses;
        if (row.active && !expired && !exhausted) {
          discountPercent = Number(row.discount_percent || 0);
          promoMeta = { code: row.code, timesUsed, maxUses };
        }
      }
    }
    const baseAmount = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : pickedPlan.amount;
    const discountAmount = Math.max(0, baseAmount * discountPercent / 100);
    const finalPrice = Math.max(0, baseAmount - discountAmount);

    await client.query('begin');
    const payment = await client.query(
      `insert into membership_payments (
         chiripero_profile_id, plan_code, amount, discount_amount, amount_final,
         payment_method, payment_reference, proof_url, status
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted')
       returning id, status, amount_final`,
      [req.params.id, plan, baseAmount, discountAmount, finalPrice, payment_method, payment_reference, proof]
    );

    if (discountPercent > 0 && promoMeta) {
      await client.query(
        `insert into promo_redemptions (code, chiripero_profile_id, membership_payment_id, discount_percent, discount_amount)
         values ($1, $2, $3, $4, $5)`,
        [promoMeta.code, req.params.id, payment.rows[0].id, discountPercent, discountAmount]
      );
      await client.query(
        `update promo_codes
         set times_used = coalesce(times_used, 0) + 1
         where code = $1`,
        [promoMeta.code]
      );
    }

    await client.query('commit');
    res.json({ ok: true, payment: payment.rows[0], final_price: finalPrice, discount_percent: discountPercent });
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
      select mp.*, p.display_name, u.full_name, u.phone,
             mp.amount_final as amount_paid
      from membership_payments mp
      join chiripero_profiles p on p.id = mp.chiripero_profile_id
      join users u on u.id = p.user_id
      where mp.status = 'submitted'
      order by mp.submitted_at desc
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/memberships/:id/decision', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { decision, note } = req.body || {};
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    await client.query('begin');
    const paymentQ = await client.query(`select * from membership_payments where id=$1`, [req.params.id]);
    if (!paymentQ.rowCount) {
      await client.query('rollback');
      return res.status(404).json({ error: 'not_found' });
    }
    const payment = paymentQ.rows[0];
    await client.query(
      `update membership_payments set status=$1, reviewed_note=$2, reviewed_by='admin', reviewed_at=now() where id=$3`,
      [decision === 'approved' ? 'approved' : 'rejected', note || null, req.params.id]
    );
    if (decision === 'approved') {
      const durationDays = payment.plan_code === 'weekly' ? 7 : payment.plan_code === 'monthly' ? 30 : 90;
      await client.query(
        `insert into memberships (chiripero_profile_id, plan, amount, payment_provider, payment_status, starts_at, ends_at)
         values ($1, $2, $3, 'manual', 'paid', now(), now() + ($4 || ' days')::interval)`,
        [payment.chiripero_profile_id, payment.plan_code, payment.amount_final, String(durationDays)]
      );
      await client.query(
        `update chiripero_profiles
         set membership_status='active', membership_plan=$1, membership_expires_at=now() + ($2 || ' days')::interval, updated_at=now()
         where id=$3`,
        [payment.plan_code, String(durationDays), payment.chiripero_profile_id]
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

app.get('/admin/promo-codes', async (_req, res) => {
  try {
    const r = await db.query(`
      select id, code, discount_percent, active, expires_at, max_uses, times_used, created_at
      from promo_codes
      order by created_at desc
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/promo-codes', async (req, res) => {
  try {
    const { code, discount_percent, expires_at, max_uses } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code_required' });
    const percent = Number(discount_percent ?? 0);
    if (Number.isNaN(percent) || percent < 0 || percent > 100) return res.status(400).json({ error: 'invalid_discount' });
    const parsedMaxUses = max_uses === '' || max_uses === null || max_uses === undefined ? null : Number(max_uses);
    if (parsedMaxUses !== null && (!Number.isInteger(parsedMaxUses) || parsedMaxUses < 1)) return res.status(400).json({ error: 'invalid_max_uses' });
    const parsedExpiresAt = expires_at ? new Date(expires_at) : null;
    if (expires_at && Number.isNaN(parsedExpiresAt.getTime())) return res.status(400).json({ error: 'invalid_expires_at' });
    const normalized = String(code).trim().toUpperCase();
    const r = await db.query(`
      insert into promo_codes (code, discount_percent, discount_type, discount_value, active, expires_at, max_uses, times_used)
      values ($1, $2, 'percent', $2, true, $3, $4, 0)
      returning id, code, discount_percent, active, expires_at, max_uses, times_used, created_at
    `, [normalized, percent, parsedExpiresAt ? parsedExpiresAt.toISOString() : null, parsedMaxUses]);
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'code_taken', message: 'Ese código ya existe' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/promo-codes/:id', async (req, res) => {
  try {
    const { code, discount_percent, active, expires_at, max_uses } = req.body || {};
    const updates = [];
    const vals = [];
    if (code !== undefined) {
      const normalized = String(code || '').trim().toUpperCase();
      if (!normalized) return res.status(400).json({ error: 'code_required' });
      vals.push(normalized);
      updates.push(`code = $${vals.length}`);
    }
    if (discount_percent !== undefined) {
      const percent = Number(discount_percent);
      if (Number.isNaN(percent) || percent < 0 || percent > 100) return res.status(400).json({ error: 'invalid_discount' });
      vals.push(percent);
      updates.push(`discount_percent = $${vals.length}`);
      vals.push('percent');
      updates.push(`discount_type = $${vals.length}`);
      vals.push(percent);
      updates.push(`discount_value = $${vals.length}`);
    }
    if (active !== undefined) { vals.push(!!active); updates.push(`active = $${vals.length}`); }
    if (expires_at !== undefined) {
      if (expires_at) {
        const parsed = new Date(expires_at);
        if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'invalid_expires_at' });
        vals.push(parsed.toISOString());
      } else {
        vals.push(null);
      }
      updates.push(`expires_at = $${vals.length}`);
    }
    if (max_uses !== undefined) {
      if (max_uses === '' || max_uses === null) {
        vals.push(null);
      } else {
        const parsedMaxUses = Number(max_uses);
        if (!Number.isInteger(parsedMaxUses) || parsedMaxUses < 1) return res.status(400).json({ error: 'invalid_max_uses' });
        vals.push(parsedMaxUses);
      }
      updates.push(`max_uses = $${vals.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
    vals.push(req.params.id);
    const r = await db.query(`
      update promo_codes
      set ${updates.join(', ')}
      where id = $${vals.length}
      returning id, code, discount_percent, active, expires_at, max_uses, times_used, created_at
    `, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'code_taken', message: 'Ese código ya existe' });
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

app.post('/chiripero/document-upload', async (req, res) => {
  try {
    const { fileBase64, fileName, docType, contentType } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: 'file_required' });
    if (!fileName) return res.status(400).json({ error: 'file_name_required' });

    const normalized = String(fileBase64).replace(/^data:[^;]+;base64,/, '');
    const inputBuffer = Buffer.from(normalized, 'base64');
    if (!inputBuffer.length) return res.status(400).json({ error: 'invalid_file' });
    if (inputBuffer.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'file_too_large' });

    const originalExt = path.extname(String(fileName || '')).toLowerCase();
    const safeBase = String(fileName || 'documento')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'documento';

    let finalExt = originalExt;
    if (!finalExt) {
      if (String(contentType || '').includes('pdf')) finalExt = '.pdf';
      else finalExt = '.jpg';
    }

    const finalName = `${Date.now()}-${String(docType || 'doc').replace(/[^a-z0-9_-]+/gi,'-')}-${safeBase.replace(/\.[^.]+$/, '')}${finalExt}`;
    const outputPath = path.join(chiriperoDocsDir, finalName);

    if (finalExt === '.pdf') {
      fs.writeFileSync(outputPath, inputBuffer);
    } else {
      await sharp(inputBuffer)
        .rotate()
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 84 })
        .toFile(outputPath.replace(/\.[^.]+$/, '.jpg'));
      finalExt = '.jpg';
    }

    const finalStoredName = finalExt === '.jpg' ? finalName.replace(/\.[^.]+$/, '.jpg') : finalName;
    const publicUrl = `/uploads/chiriperos/documents/${finalStoredName}`;
    res.json({ ok: true, file_url: publicUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
