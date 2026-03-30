require('dotenv').config();
const path = require('path');
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
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.use('/demo', express.static(path.join(__dirname, 'public')));
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
  const d = m[0].replace(/\D/g, '');
  if (d.length !== 11) return null;
  return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
}

function extractDate(text) {
  const m = text.match(/\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function extractBirthDateSpanish(text) {
  const months = {
    ENERO:'01', FEBRERO:'02', MARZO:'03', ABRIL:'04', MAYO:'05', JUNIO:'06', JULIO:'07', AGOSTO:'08',
    SEPTIEMBRE:'09', SETIEMBRE:'09', OCTUBRE:'10', NOVIEMBRE:'11', DICIEMBRE:'12'
  };
  const m = text.match(/(\d{1,2})\s+(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(\d{4})/i);
  if (!m) return null;
  const dd = String(m[1]).padStart(2, '0');
  const mm = months[m[2].toUpperCase()] || null;
  const yyyy = m[3];
  return mm ? `${yyyy}-${mm}-${dd}` : null;
}

function cleanPersonLine(v) {
  return (v || '')
    .toUpperCase()
    .replace(/[^A-ZÁÉÍÓÚÑ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikePersonName(v) {
  if (!v) return false;
  if (/(REPUBLICA|DOMINICANA|CEDULA|IDENTIDAD|ELECTORAL|SEXO|NACIMIENTO|LUGAR|SANGRE|ESTADO|OCUPACION|EXPIRACION)/.test(v)) return false;
  const words = v.split(' ').filter(Boolean);
  return words.length >= 2 && words.length <= 5;
}

function extractNames(text) {
  const upper = text.toUpperCase();

  // 1) Intento por etiqueta (NOMBRES / APELLIDOS)
  const lines = upper.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  let first = null;
  let last = null;

  for (let i = 0; i < lines.length; i++) {
    const l = cleanPersonLine(lines[i]);
    const next = cleanPersonLine(lines[i + 1] || '');

    if (!first && /NOMBRES?/.test(l)) {
      const candidate = cleanPersonLine(l.replace(/NOMBRES?/g, '')) || next;
      if (looksLikePersonName(candidate)) first = candidate;
    }
    if (!last && /APELLIDOS?/.test(l)) {
      const candidate = cleanPersonLine(l.replace(/APELLIDOS?/g, '')) || next;
      if (looksLikePersonName(candidate)) last = candidate;
    }
  }

  // 2) Fallback por mejores líneas candidatas
  if (!first || !last) {
    const candidates = lines
      .map(cleanPersonLine)
      .filter(looksLikePersonName)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);

    if (!first && candidates[0]) {
      const words = candidates[0].split(' ');
      first = words.slice(0, 2).join(' ');
      last = words.slice(2).join(' ') || null;
    }
  }

  return {
    first_name: first || null,
    last_name: last || null,
  };
}

function extractLabeledValue(text, labelRegex) {
  const m = text.match(labelRegex);
  return m ? cleanPersonLine(m[1] || '') || null : null;
}

function parseVisionTextToFields(rawText) {
  const text = String(rawText || '').replace(/```/g, '').trim();
  const upper = text.toUpperCase();

  const names = extractNames(upper);
  const cedula = extractCedula(upper);
  const birth_date = extractDate(upper) || extractBirthDateSpanish(upper);

  let birth_place = extractLabeledValue(upper, /LUGAR\s+DE\s+NACIMIENTO[:\s]+([^\n]+)/i);
  if (!birth_place) {
    const place = upper.match(/\b(SANTO\s+DOMINGO[^\n]*)\b/i);
    birth_place = place ? cleanPersonLine(place[1]) : null;
  }

  let nationality = extractLabeledValue(upper, /NACIONALIDAD[:\s]+([^\n]+)/i);
  if (!nationality && /REPUBLICA\s+DOMINICANA|REPÚBLICA\s+DOMINICANA/.test(upper)) {
    nationality = 'REPUBLICA DOMINICANA';
  }

  let civil_status = extractLabeledValue(upper, /ESTADO\s+CIVIL[:\s]+([^\n]+)/i);
  let occupation = extractLabeledValue(upper, /OCUPACION[:\s]+([^\n]+)/i);
  if (!civil_status) {
    const civil = upper.match(/\b(SOLTER[OA]|CASAD[OA]|DIVORCIAD[OA]|VIUD[OA]|UNION\s+LIBRE)\b/i);
    civil_status = civil ? cleanPersonLine(civil[1]) : null;
  }
  if (!occupation) {
    const occ = upper.match(/\b(EMPLEAD[OA]\s*\([AP]\)|EMPLEAD[OA]|ESTUDIANTE|INDEPENDIENTE|CHOFER|COMERCIANTE)\b/i);
    occupation = occ ? cleanPersonLine(occ[1]) : null;
  }

  let expires_at = null;
  const exp = upper.match(/(VENCE|EXPIRACION|EXPIRA)[:\s]+(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i);
  if (exp) {
    const d = exp[2].match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
    if (d) expires_at = `${d[3]}-${d[2]}-${d[1]}`;
  } else {
    const ym = upper.match(/VENCE\s+EN\s+(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(\d{4})/i);
    if (ym) {
      const months = {ENERO:'01',FEBRERO:'02',MARZO:'03',ABRIL:'04',MAYO:'05',JUNIO:'06',JULIO:'07',AGOSTO:'08',SEPTIEMBRE:'09',SETIEMBRE:'09',OCTUBRE:'10',NOVIEMBRE:'11',DICIEMBRE:'12'};
      const mm = months[ym[1].toUpperCase()];
      if (mm) expires_at = `${ym[2]}-${mm}-01`;
    }
  }

  const sx = (upper.match(/\bSEXO[:\s]*(M|F)\b/i) || upper.match(/\b(MASCULINO|FEMENINO)\b/i))?.[1] || null;
  const sex = sx === 'MASCULINO' ? 'M' : sx === 'FEMENINO' ? 'F' : sx;
  const blood_type = (upper.match(/\b([ABO]{1,2}[+-])\b/) || [])[1] || null;

  return {
    first_name: names.first_name || null,
    last_name: names.last_name || null,
    full_name: [names.first_name, names.last_name].filter(Boolean).join(' ') || null,
    cedula_number: cedula || null,
    birth_date: birth_date || null,
    birth_place: birth_place || null,
    nationality: nationality || null,
    sex: sex || null,
    blood_type: blood_type || null,
    civil_status: civil_status || null,
    occupation: occupation || null,
    expires_at: expires_at || null,
  };
}

async function visionExtractCedulaViaText(imageBase64) {
  const prompt = `Transcribe de forma literal TODO el texto visible de la cédula dominicana.\n- Devuelve SOLO texto plano (sin JSON, sin markdown).\n- Respeta saltos de línea cuando sea posible.`;
  const raw = await callVision(imageBase64, prompt);
  const fields = parseVisionTextToFields(raw);
  return { fields, raw: String(raw || '') };
}

app.post('/ai/extract-cedula', async (req, res) => {
  let worker;
  try {
    const { image_base64, mode } = req.body || {};
    if (!image_base64) return res.status(400).json({ error: 'missing_image' });

    const selectedMode = mode || (process.env.VISION_API_KEY ? 'vision_text' : 'ocr');

    if (selectedMode === 'vision') {
      const out = await visionExtractCedula(image_base64);
      return res.json({ ok: true, mode: 'vision', confidence: null, fields: out.fields, raw_text_preview: out.raw?.slice(0, 500) || '' });
    }

    if (selectedMode === 'vision_text') {
      const out = await visionExtractCedulaViaText(image_base64);
      return res.json({ ok: true, mode: 'vision_text', confidence: null, fields: out.fields, raw_text_preview: out.raw?.slice(0, 500) || '' });
    }

    const raw = Buffer.from(String(image_base64).split(',').pop(), 'base64');
    const processed = await sharp(raw)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();

    worker = await createWorker('eng');
    let out = await worker.recognize(processed);
    let text = out?.data?.text || '';
    let cedula = extractCedula(text);

    if (!cedula) {
      const out2 = await worker.recognize(raw);
      const text2 = out2?.data?.text || '';
      const ced2 = extractCedula(text2);
      if (ced2) {
        out = out2;
        text = text2;
        cedula = ced2;
      }
    }

    const birth_date = extractDate(text) || extractBirthDateSpanish(text.toUpperCase());
    const names = extractNames(text.toUpperCase());
    const fields = {
      first_name: names.first_name || null,
      last_name: names.last_name || null,
      full_name: [names.first_name, names.last_name].filter(Boolean).join(' ') || null,
      cedula_number: cedula || null,
      birth_date: birth_date || null,
      birth_place: null,
      nationality: null,
      sex: null,
      blood_type: null,
      civil_status: null,
      occupation: null,
      expires_at: null,
    };

    const upper = text.toUpperCase();
    const sex = upper.match(/\b([MF])\b/);
    const blood = upper.match(/\b([ABO]{1,2}[+-])\b/);
    if (sex) fields.sex = sex[1];
    if (blood) fields.blood_type = blood[1];

    res.json({ ok: true, mode: 'ocr', fields, confidence: out?.data?.confidence || null, raw_text_preview: text.slice(0, 500) });
  } catch (e) {
    res.status(500).json({
      error: e.message,
      hint: 'ocr_or_vision_failed',
      fields: {
        first_name: null,
        last_name: null,
        full_name: null,
        cedula_number: null,
        birth_date: null,
        birth_place: null,
        nationality: null,
        sex: null,
        blood_type: null,
        civil_status: null,
        occupation: null,
        expires_at: null
      }
    });
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch {}
    }
  }
});

app.get('/servicios', async (_req, res) => {
  try {
    const r = await db.query(`
      select s.id, s.name, c.name as category
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

app.get('/chiriperos', async (req, res) => {
  try {
    const { subcategory_id, subcategory, zone_id, zone, q } = req.query;
    const params = [];
    let i = 1;

    let where = `
      cp.status='approved'
      and cp.membership_status='active'
      and (cp.membership_expires_at is null or cp.membership_expires_at > now())
    `;

    if (subcategory_id) {
      where += ` and exists (
        select 1 from chiripero_services cs
        where cs.chiripero_profile_id = cp.id and cs.subcategory_id = $${i}
      )`;
      params.push(subcategory_id);
      i++;
    }

    if (subcategory) {
      where += ` and exists (
        select 1 from chiripero_services cs
        join subcategories s on s.id = cs.subcategory_id
        where cs.chiripero_profile_id = cp.id and s.name ilike $${i}
      )`;
      params.push(subcategory);
      i++;
    }

    if (zone_id) {
      where += ` and exists (
        select 1 from chiripero_zones cz
        where cz.chiripero_profile_id = cp.id and cz.zone_id = $${i}
      )`;
      params.push(zone_id);
      i++;
    }

    if (zone) {
      where += ` and exists (
        select 1 from chiripero_zones cz
        join zones z on z.id = cz.zone_id
        where cz.chiripero_profile_id = cp.id and z.name ilike $${i}
      )`;
      params.push(zone);
      i++;
    }

    if (q) {
      where += ` and (
        cp.display_name ilike $${i}
        or cp.bio ilike $${i}
        or exists (
          select 1
          from chiripero_services cs
          join subcategories s on s.id = cs.subcategory_id
          where cs.chiripero_profile_id = cp.id
            and s.name ilike $${i}
        )
      )`;
      params.push(`%${q}%`);
      i++;
    }

    const sql = `
      select cp.id, cp.display_name, cp.bio, cp.whatsapp_number, cp.call_number,
             cp.rating_avg, cp.rating_count,
             coalesce((
               select s.name
               from chiripero_services cs
               join subcategories s on s.id = cs.subcategory_id
               where cs.chiripero_profile_id = cp.id
               order by cs.years_experience desc nulls last, s.name asc
               limit 1
             ), 'Servicio general') as primary_service
      from chiripero_profiles cp
      where ${where}
      order by cp.rating_avg desc, cp.rating_count desc, cp.created_at desc
      limit 100;
    `;

    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/chiriperos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `
      select
        cp.id,
        cp.display_name,
        cp.bio,
        cp.whatsapp_number,
        cp.call_number,
        cp.rating_avg,
        cp.rating_count,
        cp.status,
        cp.documents_status,
        cp.membership_status,
        cp.membership_expires_at,
        coalesce(cp.verification_notes->>'onboarding_stage','registro') as onboarding_stage,
        coalesce(
          (
            select json_agg(jsonb_build_object('id', z.id, 'name', z.name) order by z.name)
            from chiripero_zones cz
            join zones z on z.id = cz.zone_id
            where cz.chiripero_profile_id = cp.id
          ), '[]'
        ) as zones,
        coalesce(
          (
            select json_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
            from chiripero_services cs
            join subcategories s on s.id = cs.subcategory_id
            where cs.chiripero_profile_id = cp.id
          ), '[]'
        ) as services
      from chiripero_profiles cp
      where cp.id = $1
      limit 1;
    `;

    const r = await db.query(sql, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/chiriperos', async (req, res) => {
  try {
    const { status, membership_status, q } = req.query;
    const params = [];
    let i = 1;
    const where = [];

    if (status) {
      where.push(`cp.status = $${i}::profile_status`);
      params.push(String(status));
      i++;
    }

    if (membership_status) {
      where.push(`cp.membership_status = $${i}::membership_status`);
      params.push(String(membership_status));
      i++;
    }

    if (q) {
      where.push(`(
        cp.display_name ilike $${i}
        or coalesce(cp.cedula_number,'') ilike $${i}
        or coalesce(cp.whatsapp_number,'') ilike $${i}
      )`);
      params.push(`%${String(q).trim()}%`);
      i++;
    }

    const sql = `
      select
        cp.id,
        cp.display_name,
        cp.bio,
        cp.cedula_number,
        cp.whatsapp_number,
        cp.call_number,
        cp.status,
        cp.documents_status,
        cp.membership_status,
        cp.membership_expires_at,
        cp.rating_avg,
        cp.rating_count,
        cp.created_at,
        cp.updated_at,
        coalesce(
          (
            select s.name
            from chiripero_services cs
            join subcategories s on s.id = cs.subcategory_id
            where cs.chiripero_profile_id = cp.id
            order by cs.years_experience desc nulls last, s.name asc
            limit 1
          ), 'Servicio general'
        ) as primary_service,
        coalesce(
          (
            select json_agg(jsonb_build_object('id', z.id, 'name', z.name) order by z.name)
            from chiripero_zones cz
            join zones z on z.id = cz.zone_id
            where cz.chiripero_profile_id = cp.id
          ), '[]'
        ) as zones,
        coalesce(
          (
            select count(*)::int
            from chiripero_documents d
            where d.chiripero_profile_id = cp.id
          ), 0
        ) as documents_count
      from chiripero_profiles cp
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by
        case cp.status
          when 'pending' then 0
          when 'approved' then 1
          when 'rejected' then 2
          else 3
        end,
        cp.updated_at desc nulls last,
        cp.created_at desc
      limit 250;
    `;

    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/chiriperos/pending', async (_req, res) => {
  try {
    const r = await db.query(`
      select
        cp.id as profile_id,
        cp.display_name,
        cp.cedula_number,
        cp.whatsapp_number,
        cp.status,
        cp.documents_status,
        cp.created_at,
        coalesce((
          select json_agg(jsonb_build_object('doc_type', d.doc_type, 'file_url', d.file_url, 'review_status', d.review_status) order by d.uploaded_at desc)
          from chiripero_documents d
          where d.chiripero_profile_id = cp.id
        ), '[]') as documents
      from chiripero_profiles cp
      where cp.status = 'pending'
      order by cp.created_at desc
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/chiriperos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `
      select
        cp.id,
        cp.display_name,
        cp.bio,
        cp.cedula_number,
        cp.whatsapp_number,
        cp.call_number,
        cp.status,
        cp.documents_status,
        cp.membership_status,
        cp.membership_expires_at,
        cp.rating_avg,
        cp.rating_count,
        cp.created_at,
        cp.updated_at,
        coalesce(cp.verification_notes::text, '') as verification_notes,
        coalesce(
          (
            select s.name
            from chiripero_services cs
            join subcategories s on s.id = cs.subcategory_id
            where cs.chiripero_profile_id = cp.id
            order by cs.years_experience desc nulls last, s.name asc
            limit 1
          ), 'Servicio general'
        ) as primary_service,
        coalesce(
          (
            select json_agg(jsonb_build_object('id', z.id, 'name', z.name) order by z.name)
            from chiripero_zones cz
            join zones z on z.id = cz.zone_id
            where cz.chiripero_profile_id = cp.id
          ), '[]'
        ) as zones,
        coalesce(
          (
            select json_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
            from chiripero_services cs
            join subcategories s on s.id = cs.subcategory_id
            where cs.chiripero_profile_id = cp.id
          ), '[]'
        ) as services,
        coalesce(
          (
            select json_agg(
              jsonb_build_object(
                'id', d.id,
                'doc_type', d.doc_type,
                'file_url', d.file_url,
                'uploaded_at', d.uploaded_at,
                'review_status', d.review_status,
                'review_notes', d.review_notes
              ) order by d.uploaded_at desc
            )
            from chiripero_documents d
            where d.chiripero_profile_id = cp.id
          ), '[]'
        ) as documents,
        coalesce(
          (
            select count(*)::int from contact_events ce where ce.chiripero_profile_id = cp.id and ce.type = 'whatsapp_tap'
          ), 0
        ) as whatsapp_taps,
        coalesce(
          (
            select count(*)::int from contact_events ce where ce.chiripero_profile_id = cp.id and ce.type = 'call_tap'
          ), 0
        ) as call_taps
      from chiripero_profiles cp
      where cp.id = $1
      limit 1;
    `;

    const r = await db.query(sql, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/chiriperos/:id/decision', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const { decision, note } = req.body || {};
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'invalid_decision' });
    }

    await client.query('begin');

    await client.query(
      `update chiripero_profiles
       set status = $2::profile_status,
           documents_status = case when $2::text = 'approved' then 'approved' else 'rejected' end,
           verification_notes = $3,
           documents_reviewed_at = now(),
           updated_at = now()
       where id = $1`,
      [id, decision, note || null]
    );

    await client.query(
      `update chiripero_documents
       set review_status = case when $2 = 'approved' then 'approved' else 'rejected' end,
           review_notes = coalesce($3, review_notes)
       where chiripero_profile_id = $1`,
      [id, decision, note || null]
    );

    await client.query('commit');
    res.json({ ok: true, profile_id: id, status: decision });
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
      full_name,
      first_name,
      last_name,
      phone,
      whatsapp,
      service_id,
      zone_id,
      cedula_number,
      address,
      person_photo_url,
      birth_date,
      cedula_file_url,
      buena_conducta_file_url,
    } = req.body || {};

    const computedFullName = (full_name || `${first_name || ''} ${last_name || ''}`).trim();

    if (!computedFullName || !phone || !whatsapp || !service_id || !zone_id || !cedula_file_url || !buena_conducta_file_url) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    await client.query('begin');

    const normalizedPhone = String(phone).replace(/\D/g, '').slice(-10);
    const normalizedWhats = String(whatsapp).replace(/\D/g, '').slice(-10);

    const userQ = await client.query(
      `insert into users (role, full_name, phone, email, password_hash)
       values ('chiripero', $1, $2, $3, 'pending_setup')
       on conflict (email) do update set full_name=excluded.full_name, phone=excluded.phone
       returning id`,
      [computedFullName, normalizedPhone, `${normalizedPhone}@pending.chiripapp.local`]
    );

    const userId = userQ.rows[0].id;

    const profileQ = await client.query(
      `insert into chiripero_profiles (
          user_id, display_name, bio, cedula_or_id, cedula_number,
          status, documents_status, membership_status,
          whatsapp_number, call_number
       ) values (
          $1, $2, '', $3, $3,
          'pending', 'pending', 'inactive',
          $4, $5
       )
       on conflict (user_id) do update
         set display_name=excluded.display_name,
             cedula_or_id=excluded.cedula_or_id,
             cedula_number=excluded.cedula_number,
             whatsapp_number=excluded.whatsapp_number,
             call_number=excluded.call_number,
             status='pending',
             documents_status='pending'
       returning id`,
      [userId, computedFullName, cedula_number || null, normalizedWhats, normalizedPhone]
    );

    const profileId = profileQ.rows[0].id;

    await client.query(
      `update chiripero_profiles
       set verification_notes = coalesce(verification_notes, '{}'::jsonb) || $2::jsonb
       where id = $1`,
      [profileId, JSON.stringify({ first_name: first_name || null, last_name: last_name || null, address: address || null, birth_date: birth_date || null, onboarding_stage: 'registro' })]
    );

    if (person_photo_url) {
      await client.query(
        `insert into chiripero_media (chiripero_profile_id, media_url, media_type)
         values ($1,$2,'image')`,
        [profileId, person_photo_url]
      );
    }

    await client.query(
      `insert into chiripero_services (chiripero_profile_id, subcategory_id, years_experience, base_price_note)
       values ($1,$2,null,'')
       on conflict (chiripero_profile_id, subcategory_id) do nothing`,
      [profileId, service_id]
    );

    await client.query(
      `insert into chiripero_zones (chiripero_profile_id, zone_id)
       values ($1,$2)
       on conflict (chiripero_profile_id, zone_id) do nothing`,
      [profileId, zone_id]
    );

    await client.query(
      `insert into chiripero_documents (chiripero_profile_id, doc_type, file_url, ocr_json, review_status)
       values
       ($1,'cedula_front',$2,$3::jsonb,'pending'),
       ($1,'buena_conducta',$4,null,'pending')`,
      [
        profileId,
        cedula_file_url,
        JSON.stringify({ extracted_name: full_name, extracted_cedula: cedula_number || null, mode: 'demo_prefill' }),
        buena_conducta_file_url,
      ]
    );

    await client.query('commit');
    res.status(201).json({ ok: true, profile_id: profileId, status: 'pending_review' });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/chiriperos/:id/ad-setup', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const profileId = String(req.params.id || '').trim();
    if (!profileId) return res.status(400).json({ error: 'invalid_profile_id' });

    const {
      title,
      bio,
      base_price_note,
      years_experience,
      service_ids,
      zone_ids,
      work_photos,
      available_hours,
    } = req.body || {};

    if (!bio || !Array.isArray(service_ids) || service_ids.length === 0 || !Array.isArray(zone_ids) || zone_ids.length === 0) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const p = await client.query(`select id, status, display_name from chiripero_profiles where id=$1`, [profileId]);
    if (!p.rowCount) return res.status(404).json({ error: 'profile_not_found' });

    await client.query('begin');

    await client.query(
      `update chiripero_profiles
       set display_name = coalesce($2, display_name),
           bio = $3,
           verification_notes = (coalesce(nullif(verification_notes,''),'{}'))::jsonb || $4::jsonb,
           updated_at = now()
       where id = $1`,
      [
        profileId,
        title || null,
        String(bio).trim(),
        JSON.stringify({
          available_hours: available_hours || null,
          ad_setup_completed_at: new Date().toISOString(),
          onboarding_stage: 'membresia_pago',
        }),
      ]
    );

    await client.query(`delete from chiripero_services where chiripero_profile_id=$1`, [profileId]);
    for (const sid of service_ids.map((v) => String(v).trim()).filter(Boolean)) {
      await client.query(
        `insert into chiripero_services (chiripero_profile_id, subcategory_id, years_experience, base_price_note)
         values ($1,$2,$3,$4)
         on conflict (chiripero_profile_id, subcategory_id) do update
         set years_experience = excluded.years_experience,
             base_price_note = excluded.base_price_note`,
        [profileId, sid, years_experience ?? null, base_price_note || '']
      );
    }

    await client.query(`delete from chiripero_zones where chiripero_profile_id=$1`, [profileId]);
    for (const zid of zone_ids.map((v) => String(v).trim()).filter(Boolean)) {
      await client.query(
        `insert into chiripero_zones (chiripero_profile_id, zone_id)
         values ($1,$2)
         on conflict (chiripero_profile_id, zone_id) do nothing`,
        [profileId, zid]
      );
    }

    if (Array.isArray(work_photos)) {
      for (const url of work_photos.filter(Boolean)) {
        await client.query(
          `insert into chiripero_media (chiripero_profile_id, media_url, media_type)
           values ($1,$2,'image')`,
          [profileId, String(url)]
        );
      }
    }

    await client.query('commit');
    res.json({ ok: true, profile_id: profileId, ad_setup: 'saved' });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

const MEMBERSHIP_PLANS = {
  weekly: { code: 'weekly', label: 'Semanal', amount: 300, days: 7 },
  monthly: { code: 'monthly', label: 'Mensual', amount: 1000, days: 30 },
  quarterly: { code: 'quarterly', label: 'Trimestral', amount: 2500, days: 90 },
};

async function ensurePromoCatalog() {
  await db.query(`
    create table if not exists promo_codes (
      code text primary key,
      discount_type text not null default 'percent',
      discount_value numeric(10,2) not null,
      active boolean not null default true,
      starts_at timestamptz null,
      ends_at timestamptz null,
      notes text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (discount_type in ('percent','fixed'))
    )
  `);

  await db.query(
    `insert into promo_codes (code, discount_type, discount_value, active, notes)
     values ('AMIN25','percent',25,true,'Promo de prueba inicial')
     on conflict (code) do update set
       discount_type = excluded.discount_type,
       discount_value = excluded.discount_value,
       active = excluded.active,
       notes = excluded.notes,
       updated_at = now()`
  );
}

async function getPromoDiscount(client, code, baseAmount) {
  if (!code) return { valid: false, code: null, percent: 0, discountAmount: 0 };
  const normalized = String(code).trim().toUpperCase();
  const q = await client.query(
    `select code, discount_type, discount_value
     from promo_codes
     where code = $1
       and active = true
       and (starts_at is null or starts_at <= now())
       and (ends_at is null or ends_at >= now())
     limit 1`,
    [normalized]
  );
  if (!q.rowCount) return { valid: false, code: normalized, percent: 0, discountAmount: 0 };

  const row = q.rows[0];
  const amount = Number(baseAmount || 0);
  let discountAmount = 0;
  let percent = 0;

  if (row.discount_type === 'percent') {
    percent = Math.max(0, Math.min(100, Number(row.discount_value || 0)));
    discountAmount = (amount * percent) / 100;
  } else {
    discountAmount = Number(row.discount_value || 0);
    percent = amount > 0 ? (discountAmount / amount) * 100 : 0;
  }

  discountAmount = Math.max(0, Math.min(amount, discountAmount));
  percent = Math.max(0, Math.min(100, percent));

  return {
    valid: true,
    code: row.code,
    percent: Math.round(percent),
    discountAmount: Math.round(discountAmount * 100) / 100,
  };
}


app.get('/promo-codes/validate', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    const amount = Number(req.query.amount || 0);
    const promo = await getPromoDiscount(db, code, amount);
    res.json(promo);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/membership/plans', async (_req, res) => {
  const weekly = MEMBERSHIP_PLANS.weekly.amount;
  const monthly = MEMBERSHIP_PLANS.monthly.amount;
  const quarterly = MEMBERSHIP_PLANS.quarterly.amount;

  const monthlyEquivalent = weekly * 4;
  const monthlySavings = monthlyEquivalent > 0 ? Math.round(((monthlyEquivalent - monthly) / monthlyEquivalent) * 100) : 0;

  const quarterlyEquivalent = weekly * 12;
  const quarterlySavings = quarterlyEquivalent > 0 ? Math.round(((quarterlyEquivalent - quarterly) / quarterlyEquivalent) * 100) : 0;

  let popularity = { weekly: 0, monthly: 0, quarterly: 0 };
  try {
    const popQ = await db.query(`
      select
        coalesce((coalesce(nullif(verification_notes,''),'{}'))::jsonb->>'plan_code','weekly') as plan_code,
        count(*)::int as total
      from chiripero_profiles
      where coalesce((coalesce(nullif(verification_notes,''),'{}'))::jsonb->>'payment_status','') = 'approved'
      group by 1
    `);
    for (const row of popQ.rows) {
      const key = String(row.plan_code || '').trim();
      if (Object.prototype.hasOwnProperty.call(popularity, key)) popularity[key] = Number(row.total || 0);
    }
  } catch {}

  const max = Math.max(popularity.weekly, popularity.monthly, popularity.quarterly);
  const mostPopular = max > 0
    ? Object.entries(popularity).sort((a,b)=>b[1]-a[1])[0][0]
    : 'quarterly';

  res.json({
    plans: [
      { ...MEMBERSHIP_PLANS.weekly, popularity_count: popularity.weekly, most_popular: mostPopular === 'weekly' },
      { ...MEMBERSHIP_PLANS.monthly, savings_percent: monthlySavings, popularity_count: popularity.monthly, most_popular: mostPopular === 'monthly' },
      { ...MEMBERSHIP_PLANS.quarterly, savings_percent: quarterlySavings, popularity_count: popularity.quarterly, most_popular: mostPopular === 'quarterly' },
    ]
  });
});

app.post('/chiriperos/:id/membership-submit', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const profileId = String(req.params.id || '').trim();
    if (!profileId) return res.status(400).json({ error: 'invalid_profile_id' });

    const {
      plan_code,
      payment_method,
      promo_code,
      payment_reference,
      payment_proof_url,
      amount,
      note,
    } = req.body || {};

    if (!plan_code || !payment_method || !payment_reference || !payment_proof_url) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const plan = MEMBERSHIP_PLANS[String(plan_code)] || null;
    if (!plan) return res.status(400).json({ error: 'invalid_plan_code' });

    const profileQ = await client.query(`select id from chiripero_profiles where id=$1`, [profileId]);
    if (!profileQ.rowCount) return res.status(404).json({ error: 'profile_not_found' });

    await client.query('begin');

    const baseAmount = Number(amount || plan.amount);
    const promo = await getPromoDiscount(client, promo_code, baseAmount);
    const finalAmount = Math.max(0, baseAmount - Number(promo.discountAmount || 0));

    const payload = {
      payment_status: 'submitted',
      onboarding_stage: 'en_revision',
      submitted_at: new Date().toISOString(),
      plan_code: plan.code,
      plan_label: plan.label,
      amount: baseAmount,
      amount_final: finalAmount,
      payment_method: String(payment_method),
      payment_reference: String(payment_reference),
      payment_proof_url: String(payment_proof_url),
      promo_code: promo.valid ? promo.code : null,
      promo_percent: promo.valid ? promo.percent : 0,
      promo_discount_amount: promo.valid ? promo.discountAmount : 0,
      note: note ? String(note) : null,
    };

    await client.query(
      `update chiripero_profiles
       set membership_status = 'pending',
           verification_notes = coalesce(verification_notes, '{}'::jsonb) || $2::jsonb,
           updated_at = now()
       where id = $1`,
      [profileId, JSON.stringify(payload)]
    );

    await client.query(
      `insert into chiripero_documents (chiripero_profile_id, doc_type, file_url, ocr_json, review_status)
       values ($1,'membership_payment_proof',$2,$3::jsonb,'pending')`,
      [
        profileId,
        payment_proof_url,
        JSON.stringify({
          plan_code: plan.code,
          amount: Number(amount || plan.amount),
          payment_method: payment_method,
          payment_reference: payment_reference,
          promo_code: promo_code || null,
        }),
      ]
    );

    await client.query('commit');
    res.json({ ok: true, profile_id: profileId, membership_status: 'pending' });
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
      select
        cp.id as profile_id,
        cp.display_name,
        cp.whatsapp_number,
        cp.membership_status,
        cp.verification_notes,
        cp.updated_at,
        coalesce((
          select json_agg(jsonb_build_object('doc_type', d.doc_type, 'file_url', d.file_url, 'review_status', d.review_status, 'uploaded_at', d.uploaded_at) order by d.uploaded_at desc)
          from chiripero_documents d
          where d.chiripero_profile_id = cp.id and d.doc_type = 'membership_payment_proof'
        ), '[]') as payment_documents
      from chiripero_profiles cp
      where cp.membership_status = 'pending'
      order by cp.updated_at desc
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/memberships/:id/decision', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const profileId = String(req.params.id || '').trim();
    const { decision, note } = req.body || {};
    if (!profileId) return res.status(400).json({ error: 'invalid_profile_id' });
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });

    const q = await client.query(`select verification_notes from chiripero_profiles where id=$1`, [profileId]);
    if (!q.rowCount) return res.status(404).json({ error: 'profile_not_found' });
    const notes = q.rows[0].verification_notes || {};
    const planCode = notes.plan_code || 'weekly';
    const plan = MEMBERSHIP_PLANS[planCode] || MEMBERSHIP_PLANS.weekly;

    await client.query('begin');

    if (decision === 'approved') {
      await client.query(
        `update chiripero_profiles
         set membership_status='active',
             status='approved',
             membership_expires_at = now() + ($2 || ' days')::interval,
             verification_notes = coalesce(verification_notes, '{}'::jsonb) || $3::jsonb,
             updated_at = now()
         where id=$1`,
        [
          profileId,
          String(plan.days),
          JSON.stringify({ payment_status: 'approved', onboarding_stage: 'completado', payment_reviewed_at: new Date().toISOString(), payment_review_note: note || null }),
        ]
      );
    } else {
      await client.query(
        `update chiripero_profiles
         set membership_status='inactive',
             verification_notes = coalesce(verification_notes, '{}'::jsonb) || $2::jsonb,
             updated_at = now()
         where id=$1`,
        [
          profileId,
          JSON.stringify({ payment_status: 'rejected', onboarding_stage: 'membresia_pago', payment_reviewed_at: new Date().toISOString(), payment_review_note: note || null }),
        ]
      );
    }

    await client.query(
      `update chiripero_documents
       set review_status = case when $2 = 'approved' then 'approved' else 'rejected' end,
           review_notes = coalesce($3, review_notes)
       where chiripero_profile_id = $1 and doc_type = 'membership_payment_proof'`,
      [profileId, decision, note || null]
    );

    await client.query('commit');
    res.json({ ok: true, profile_id: profileId, decision, membership_status: decision === 'approved' ? 'active' : 'inactive' });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/chiriperos/:id/onboarding-stage', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const profileId = String(req.params.id || '').trim();
    const stage = String(req.body?.stage || '').trim();
    const valid = ['registro','anuncio','membresia_pago','en_revision','completado'];
    if (!profileId) return res.status(400).json({ error: 'invalid_profile_id' });
    if (!valid.includes(stage)) return res.status(400).json({ error: 'invalid_stage' });

    await client.query(
      `update chiripero_profiles
       set verification_notes = coalesce(verification_notes, '{}'::jsonb) || $2::jsonb,
           membership_status = case when $3 = 'completado' then 'active'::membership_status else membership_status end,
           updated_at = now()
       where id = $1`,
      [profileId, JSON.stringify({ onboarding_stage: stage }), stage]
    );

    await client.query(
      `insert into onboarding_progress(chiripero_profile_id, stage, status, actor, note)
       values ($1, $2::onboarding_stage, 'done', 'system', 'stage update')`,
      [profileId, stage]
    );

    res.json({ ok: true, profile_id: profileId, onboarding_stage: stage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/contact-events', async (req, res) => {
  try {
    const { client_user_id = null, chiripero_profile_id, type } = req.body;
    if (!chiripero_profile_id || !['whatsapp_tap', 'call_tap'].includes(type)) {
      return res.status(400).json({ error: 'invalid payload' });
    }

    const r = await db.query(
      `insert into contact_events (client_user_id, chiripero_profile_id, type)
       values ($1,$2,$3) returning id, created_at`,
      [client_user_id, chiripero_profile_id, type]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN CATÁLOGO: CATEGORÍAS =====
app.get('/admin/catalogo/categorias', async (_req, res) => {
  try {
    const r = await db.query(`
      select c.id, c.name, c.is_active, c.created_at,
        coalesce(json_agg(json_build_object('id',s.id,'name',s.name,'is_active',s.is_active)
          order by s.name) filter (where s.id is not null), '[]') as subcategories
      from categories c
      left join subcategories s on s.category_id = c.id
      group by c.id order by c.name
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/catalogo/categorias', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
    const r = await db.query(
      `insert into categories (name) values ($1) returning *`,
      [name.trim()]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'categoria_ya_existe' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/catalogo/categorias/:id', async (req, res) => {
  try {
    const { name, is_active } = req.body || {};
    const id = req.params.id;
    const updates = [];
    const vals = [];
    if (name !== undefined) { vals.push(name.trim()); updates.push(`name=$${vals.length}`); }
    if (is_active !== undefined) { vals.push(is_active); updates.push(`is_active=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
    vals.push(id);
    const r = await db.query(
      `update categories set ${updates.join(',')} where id=$${vals.length} returning *`,
      vals
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'nombre_duplicado' });
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
    if (!category_id || !name?.trim()) return res.status(400).json({ error: 'category_id_and_name_required' });
    const r = await db.query(
      `insert into subcategories (category_id, name) values ($1,$2) returning *`,
      [category_id, name.trim()]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'servicio_ya_existe' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/catalogo/subcategorias/:id', async (req, res) => {
  try {
    const { name, is_active } = req.body || {};
    const id = req.params.id;
    const updates = [];
    const vals = [];
    if (name !== undefined) { vals.push(name.trim()); updates.push(`name=$${vals.length}`); }
    if (is_active !== undefined) { vals.push(is_active); updates.push(`is_active=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
    vals.push(id);
    const r = await db.query(
      `update subcategories set ${updates.join(',')} where id=$${vals.length} returning *`,
      vals
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'nombre_duplicado' });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/catalogo/zonas', async (req, res) => {
  try {
    const { name, city = 'Santo Domingo' } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
    const r = await db.query(
      `insert into zones (name, city) values ($1,$2) returning *`,
      [name.trim(), city.trim()]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'zona_ya_existe' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/admin/catalogo/zonas/:id', async (req, res) => {
  try {
    const { name, city, is_active } = req.body || {};
    const id = req.params.id;
    const updates = [];
    const vals = [];
    if (name !== undefined) { vals.push(name.trim()); updates.push(`name=$${vals.length}`); }
    if (city !== undefined) { vals.push(city.trim()); updates.push(`city=$${vals.length}`); }
    if (is_active !== undefined) { vals.push(is_active); updates.push(`is_active=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
    vals.push(id);
    const r = await db.query(
      `update zones set ${updates.join(',')} where id=$${vals.length} returning *`,
      vals
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'nombre_duplicado' });
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

// --- Migración: columnas username, avatar_url, ad_banner_url, ad_text ---
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

// POST /chiripero/login
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
    // Retornar datos del chiripero sin el hash
    const { password_hash, ...safe } = user;
    res.json({ ok: true, chiripero: safe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /chiripero/:profileId/me  — datos del perfil
app.get('/chiripero/:profileId/me', async (req, res) => {
  try {
    const r = await db.query(
      `select u.id as user_id, u.full_name, u.phone, u.email, u.username,
              p.id as profile_id, p.display_name, p.status, p.membership_status,
              p.membership_expires_at, p.membership_plan, p.whatsapp_number, p.call_number,
              p.avatar_url, p.ad_banner_url, p.ad_text, p.ad_banner_type,
              p.bio, p.cedula_number, p.verification_notes, p.created_at
       from chiripero_profiles p
       join users u on u.id = p.user_id
       where p.id = $1`,
      [req.params.profileId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /chiripero/:profileId/perfil  — editar datos del perfil
app.patch('/chiripero/:profileId/perfil', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { display_name, phone, whatsapp_number, call_number, bio, avatar_url } = req.body || {};
    const profileId = req.params.profileId;
    await client.query('begin');
    // Actualizar profile
    const profUpdates = [];
    const profVals = [];
    if (display_name !== undefined) { profVals.push(display_name.trim()); profUpdates.push(`display_name=$${profVals.length}`); }
    if (whatsapp_number !== undefined) { profVals.push(String(whatsapp_number).replace(/\D/g,'').slice(-10)); profUpdates.push(`whatsapp_number=$${profVals.length}`); }
    if (call_number !== undefined) { profVals.push(String(call_number).replace(/\D/g,'').slice(-10)); profUpdates.push(`call_number=$${profVals.length}`); }
    if (bio !== undefined) { profVals.push(bio.trim()); profUpdates.push(`bio=$${profVals.length}`); }
    if (avatar_url !== undefined) { profVals.push(avatar_url); profUpdates.push(`avatar_url=$${profVals.length}`); }
    if (profUpdates.length) {
      profVals.push(profileId);
      await client.query(`update chiripero_profiles set ${profUpdates.join(',')}, updated_at=now() where id=$${profVals.length}`, profVals);
    }
    // Actualizar phone en users
    if (phone !== undefined) {
      const normalizedPhone = String(phone).replace(/\D/g,'').slice(-10);
      const userQ = await client.query(`select user_id from chiripero_profiles where id=$1`, [profileId]);
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

// PATCH /chiripero/:profileId/password  — cambiar contraseña
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

// DELETE /chiripero/:profileId/baja  — darse de baja
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

// PATCH /chiripero/:profileId/anuncio  — gestión del anuncio
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

// ===== SETUP ENDPOINT (run once to initialize DB) =====
app.post('/internal/setup-db', async (req, res) => {
  const secret = req.headers['x-setup-secret'];
  if (secret !== process.env.SETUP_SECRET && secret !== 'chiripapp-setup-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const fs = require('fs');
  const path = require('path');
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
// ===== SETUP: ASIGNAR CREDENCIALES CHIRIPERO =====
app.post('/internal/set-chiripero-credentials', async (req, res) => {
  const secret = req.headers['x-setup-secret'];
  if (secret !== process.env.SETUP_SECRET && secret !== 'chiripapp-setup-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const { profile_id, username, password, status, membership_status, display_name, bio, ad_text } = req.body || {};
    if (!profile_id || !username || !password) return res.status(400).json({ error: 'missing_fields' });
    const pwd_hash = await bcrypt.hash(password, 10);
    // Actualizar user
    await db.query(
      `UPDATE users SET username=$1, password_hash=$2, updated_at=now()
       WHERE id=(SELECT user_id FROM chiripero_profiles WHERE id=$3)`,
      [username, pwd_hash, profile_id]
    );
    // Actualizar perfil
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
// ===== END SETUP ENDPOINT =====

const port = process.env.PORT || 8088;
Promise.allSettled([ensurePromoCatalog(), ensureChiriperoPortalColumns()])
  .then(() => {
    app.listen(port, () => {
      console.log(`CHIRIPAPP backend running on :${port}`);
    });
  });


