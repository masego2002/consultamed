const CR = 'https://consultaremedios.com.br';
const APP_VERSION = '1.4';
const MAX_CR_BYTES = 12_000_000;
const MAX_STOCK_TERMS = 48;
const STOCK_BATCH_SIZE = 4;

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const term = String(body?.term || '').trim().slice(0, 180);
    const requestedFormula = String(body?.formula || '').trim().slice(0, 280);
    if (term.length < 2) return json({error: 'Pesquisa muito curta.'}, 400);

    const cr = await searchCR(term, requestedFormula);
    let stockRows = [];
    const notes = [...cr.notes];

    const mbileUrl = String(body?.mbileUrl || '').trim();
    const mbileCode = String(body?.mbileCode || '').trim();

    if (mbileUrl && mbileCode) {
      try {
        stockRows = await searchStock(mbileUrl, mbileCode, term, cr.records, cr.formulas);
      } catch (error) {
        notes.push('Estoque indisponível: ' + safeMessage(error));
      }
    }

    const usedStock = new Set();
    const records = [];

    for (const record of cr.records) {
      const stock = associate(record, stockRows);
      if (stock) usedStock.add(stock.id);

      if (isGeneric(record) && (!stock || Number(stock.qty) < 1)) continue;

      records.push({...record, stock: stock || null});
    }

    if (mbileUrl && mbileCode) {
      for (const row of stockRows) {
        if (usedStock.has(row.id) || Number(row.qty) < 1) continue;
        if (!isStockRowRelevant(row, term, cr.records, cr.formulas)) continue;

        const formulaHint = cr.formulas.length === 1 ? cr.formulas[0] : '';
        records.push({
          source: 'MBILE',
          name: row.name,
          active: formulaHint,
          brand: '',
          ean: row.ean || '',
          family: '',
          base_name: row.name,
          kind: '',
          image: '',
          url: `${CR}/busca?termo=${encodeURIComponent(row.name)}`,
          stock: row
        });
      }
    }

    const unique = new Map();
    for (const record of records) {
      const key = record.ean ? `ean:${record.ean}` : `name:${norm(record.name)}|${norm(record.active)}`;
      unique.set(key, mergeRecord(unique.get(key), record));
    }

    const finalRecords = [...unique.values()];
    finalRecords.sort((a, b) => norm(a.name).localeCompare(norm(b.name), 'pt-BR'));
    return json({records: finalRecords.slice(0, 500), notes: [...new Set(notes)], formulas: cr.formulas});
  } catch (error) {
    return json({error: safeMessage(error)}, 500);
  }
}

async function searchCR(term, requestedFormula = '') {
  const notes = new Set();
  const collected = new Map();
  const paLinks = new Map();

  const collectQuery = async (query) => {
    const q = String(query || '').trim();
    if (q.length < 2) return;
    try {
      const html = await fetchText(`${CR}/busca?termo=${encodeURIComponent(q)}`, 'CR');
      const parsed = parseCR(html);
      parsed.records.forEach((r) => collected.set(r.url, mergeRecord(collected.get(r.url), r)));
      parsed.pa.forEach((url, label) => paLinks.set(label, url));
    } catch (_) {
      notes.add('Consulta Remédios parcialmente indisponível');
    }
  };

  const termTokens = [...new Set(norm(term).split(' '))].filter(Boolean);
  const alphaTokens = termTokens.filter((t) => /^[a-z]+$/.test(t) && !STOP_TOKENS.has(t));
  const baseQueries = [...new Set([term, alphaTokens[0] || ''])].filter(Boolean).slice(0, 2);
  for (const q of baseQueries) await collectQuery(q);

  let formulas = requestedFormula ? [requestedFormula] : inferFormulas(term, [...collected.values()]);

  for (const formula of formulas.slice(0, 3)) {
    for (const q of formulaQueries(formula)) await collectQuery(q);
  }

  if (!formulas.length) formulas = inferFormulas(term, [...collected.values()]);

  const ingredientTerms = [...new Set(formulas.flatMap(splitFormula).map(norm).filter(Boolean))];
  const relatedPa = [...paLinks.entries()]
    .filter(([label]) => ingredientTerms.some((ingredient) => formulaPartRelated(label, ingredient)))
    .map(([, url]) => url)
    .filter((url, index, arr) => arr.indexOf(url) === index)
    .slice(0, 8);

  for (const url of relatedPa) {
    try {
      const html = await fetchText(url, 'CR');
      const parsed = parseCR(html);
      parsed.records.forEach((r) => collected.set(r.url, mergeRecord(collected.get(r.url), r)));
    } catch (_) {
      notes.add('Marcas relacionadas parcialmente indisponíveis');
    }
  }

  if (!formulas.length) formulas = inferFormulas(term, [...collected.values()]);
  formulas = [...new Map(formulas.map((f) => [formulaSignature(f) || norm(f), f])).values()].filter(Boolean).slice(0, 5);

  const records = [...collected.values()].filter((record) => {
    const direct = matches(term, [record.name, record.active, record.brand, record.ean].join(' '));
    const sameFormula = formulas.some((formula) => formulaEquivalent(record.active, formula));
    return direct || sameFormula;
  });

  return {records, notes: [...notes], formulas};
}

const STOP_TOKENS = new Set(['mg','ml','g','mcg','ui','com','caixa','comprimido','comprimidos','capsula','capsulas','frasco','blister','blisteres']);

function inferFormulas(term, records) {
  const ranked = new Map();
  const normalizedTerm = norm(term);

  for (const record of records) {
    const active = String(record.active || '').trim();
    if (!active) continue;

    const brandFields = [record.name, record.brand, record.ean].join(' ');
    const activeField = record.active || '';
    let score = 0;

    if (matches(term, brandFields)) score += 50;
    if (matches(term, activeField)) score += 35;
    if (norm(record.name).startsWith(normalizedTerm)) score += 12;
    if (norm(activeField) === normalizedTerm) score += 20;
    if (!score) continue;

    const key = formulaSignature(active) || norm(active);
    const current = ranked.get(key) || {formula: active, score: 0, count: 0};
    current.score += score;
    current.count += 1;
    ranked.set(key, current);
  }

  return [...ranked.values()]
    .sort((a, b) => (b.score + b.count * 3) - (a.score + a.count * 3))
    .slice(0, 3)
    .map((item) => item.formula);
}

function formulaQueries(formula) {
  const parts = splitFormula(formula);
  const queries = [formula, ...parts];
  for (const part of parts) {
    const core = ingredientCore(part);
    if (core && norm(core) !== norm(part)) queries.push(core);
  }
  return [...new Set(queries.map((q) => String(q || '').trim()).filter((q) => q.length >= 2))].slice(0, 7);
}

function splitFormula(value) {
  return String(value || '')
    .split(/\s*\+\s*|\s*;\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function ingredientCore(value) {
  return String(value || '')
    .replace(/\b(monoi?dratad[oa]|monohidratad[oa]|hidratad[oa]|anidr[oa])\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalIngredient(value) {
  return norm(ingredientCore(value));
}

function formulaSignature(value) {
  const parts = splitFormula(value).map(canonicalIngredient).filter(Boolean).sort();
  return parts.join('|');
}

function formulaEquivalent(a, b) {
  const sigA = formulaSignature(a);
  const sigB = formulaSignature(b);
  if (!sigA || !sigB) return false;
  return sigA === sigB;
}

function formulaPartRelated(a, b) {
  const aa = canonicalIngredient(a);
  const bb = canonicalIngredient(b);
  if (!aa || !bb) return false;
  return aa === bb || aa.includes(bb) || bb.includes(aa);
}

function parseCR(html) {
  const records = [];
  const pa = new Map();

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+\/pa(?:[?#][^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = norm(stripTags(m[2]));
    const url = cleanCRUrl(m[1]);
    if (label && url) pa.set(label, url);
  }

  for (const m of html.matchAll(/<script\b[^>]*type=["'][^"']*json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let payload;
    try { payload = JSON.parse(m[1].trim()); } catch { continue; }

    for (const obj of walkObjects(payload)) {
      const href = typeof obj.url === 'string' ? cleanCRUrl(obj.url) : '';
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (!href || !name || !new URL(href).pathname.endsWith('/p')) continue;
      if (!(obj.productID || obj['@type'] === 'Product' || obj['@type'] === 'Drug')) continue;

      const props = Array.isArray(obj.additionalProperty) ? obj.additionalProperty : [];
      let active = valueFromProps(props, 'principio ativo');
      if (!active && Array.isArray(obj.activeIngredient)) {
        active = obj.activeIngredient.map((x) => typeof x === 'object' ? x?.name : x).filter(Boolean).join(' + ');
      }

      const rawEan = String(obj.gtin13 || obj.gtin || obj.sku || '');
      const ean = /^\d{8,14}$/.test(rawEan) ? rawEan : '';
      let brand = obj.brand || obj.manufacturer || '';
      if (brand && typeof brand === 'object') brand = brand.name || '';
      const pathParts = new URL(href).pathname.replace(/^\//, '').split('/');
      const family = pathParts[0] || '';
      let kind = '';
      if (obj.classification && typeof obj.classification === 'object') kind = obj.classification.classificationName || '';
      if (!kind) kind = valueFromProps(props, 'tipo do medicamento');

      records.push({
        source: 'CR',
        url: href,
        name,
        active: String(active || ''),
        brand: String(brand || ''),
        ean,
        family,
        base_name: String(obj.alternateName || name.split(' ')[0] || family.replaceAll('-', ' ')),
        kind: String(kind || ''),
        image: cleanImageUrl(imageFromObject(obj.image))
      });
    }
  }

  const unique = new Map();
  for (const record of records) unique.set(record.url, mergeRecord(unique.get(record.url), record));
  return {records: [...unique.values()], pa};
}

function imageFromObject(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = imageFromObject(item);
      if (image) return image;
    }
  }
  if (value && typeof value === 'object') return value.url || value.contentUrl || value.thumbnailUrl || '';
  return '';
}

function cleanImageUrl(value) {
  try {
    const url = new URL(String(value || ''), CR);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

async function searchStock(link, code, term, crRecords, formulas = []) {
  const login = await loginMBILE(link, code);
  const terms = [];
  const addTerm = (value) => {
    const q = String(value || '').trim();
    if (q.length < 2 || terms.some((x) => norm(x) === norm(q))) return;
    terms.push(q);
  };

  addTerm(term);
  for (const formula of formulas) {
    addTerm(formula);
    for (const part of splitFormula(formula)) {
      addTerm(part);
      addTerm(ingredientCore(part));
    }
  }
  for (const record of crRecords) {
    addTerm(record.base_name || record.family?.replaceAll('-', ' ') || '');
    if (terms.length >= MAX_STOCK_TERMS) break;
  }

  const rows = new Map();
  const limited = terms.slice(0, MAX_STOCK_TERMS);

  for (let i = 0; i < limited.length; i += STOCK_BATCH_SIZE) {
    const batch = limited.slice(i, i + STOCK_BATCH_SIZE);
    const responses = await Promise.allSettled(batch.map(async (q) => {
      const url = `${login.base}/produtos?q=${encodeURIComponent(q)}`;
      const response = await safeFetch(url, {headers: {'cookie': login.cookie, 'user-agent': `Mozilla/5.0 ConsultaMed/${APP_VERSION}`}}, true);
      const html = await response.text();
      return parseStock(html);
    }));

    for (const result of responses) {
      if (result.status !== 'fulfilled') continue;
      for (const row of result.value) rows.set(row.id || `${norm(row.name)}|${row.ean}`, row);
    }
  }

  return [...rows.values()];
}

async function loginMBILE(link, code) {
  const initial = await safeFetch(normalizeMBILEUrl(link), {headers: {'user-agent': `Mozilla/5.0 ConsultaMed/${APP_VERSION}`}}, true);
  const initialHtml = await initial.text();
  if (!/name=["']codigo["']/i.test(initialHtml)) throw new Error('Autenticação do MBILE não encontrada.');

  const base = new URL(initial.url).origin;
  if (!isAllowedMBILEHost(new URL(base).hostname)) throw new Error('Destino do MBILE não permitido.');

  const initialCookie = extractCookies(initial.headers);
  const loginResponse = await safeFetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cookie': initialCookie,
      'user-agent': `Mozilla/5.0 ConsultaMed/${APP_VERSION}`
    },
    body: new URLSearchParams({codigo: code}).toString()
  }, false);

  const cookie = mergeCookies(initialCookie, extractCookies(loginResponse.headers));
  if (!cookie) throw new Error('Sessão do MBILE não foi criada.');

  const check = await safeFetch(`${base}/produtos?q=${encodeURIComponent('___verificacao_de_conexao___')}`, {headers: {'cookie': cookie, 'user-agent': `Mozilla/5.0 ConsultaMed/${APP_VERSION}`}}, true);
  const checkHtml = await check.text();
  parseStock(checkHtml);
  return {base, cookie};
}

function parseStock(html) {
  if (/name=["']codigo["']/i.test(html)) throw new Error('Código incorreto ou sessão encerrada.');
  if (!/name=["']q["']/i.test(html)) throw new Error('Página de produtos do MBILE não encontrada.');

  const rows = [];
  for (const m of html.matchAll(/<article\b[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = m[1];
    const anchor = block.match(/<a\b[^>]*href=["']\/produto\?([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const params = new URLSearchParams(anchor[1].replaceAll('&amp;', '&'));
    const id = params.get('id') || '';
    const name = stripTags(anchor[2]).trim();
    const text = stripTags(block);
    const bar = text.match(/Barras\s+([^\s]+)/i);
    const stock = text.match(/Estoque:\s*([\d.,\-]+)/i);
    if (!stock) continue;
    const qty = Number(stock[1].replaceAll('.', '').replace(',', '.'));
    const priceMatch = block.match(/<span\b[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    rows.push({id, name, ean: bar?.[1] || '', qty: Number.isFinite(qty) ? qty : 0, price: priceMatch ? stripTags(priceMatch[1]).trim() : ''});
  }
  return rows;
}

function associate(record, rows) {
  if (!rows.length) return null;

  const eanMatches = record.ean ? rows.filter((r) => r.ean && r.ean === record.ean) : [];
  if (eanMatches.length) return eanMatches.sort((a, b) => Number(b.qty) - Number(a.qty))[0];

  const recordName = norm(record.name);
  const base = norm(record.base_name || record.family?.replaceAll('-', ' ') || record.name);
  if (!base) return null;

  const numericTokens = recordName.split(' ').filter((t) => /\d/.test(t));
  const recordTokens = new Set(recordName.split(' ').filter(Boolean));
  let best = null;
  let bestScore = -Infinity;

  for (const row of rows) {
    const rowName = norm(row.name);
    if (!rowName) continue;
    const baseMatches = matches(base, rowName) || matches(rowName.split(' ').slice(0, 2).join(' '), base);
    if (!baseMatches) continue;
    if (numericTokens.length && !numericTokens.every((token) => rowName.includes(token))) continue;

    const rowTokens = new Set(rowName.split(' ').filter(Boolean));
    let overlap = 0;
    for (const token of recordTokens) if (rowTokens.has(token)) overlap += 1;

    let score = overlap * 4;
    if (rowName === recordName) score += 120;
    if (rowName.startsWith(base) || recordName.startsWith(norm(row.name.split(' ')[0]))) score += 25;
    if (Number(row.qty) >= 1) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return bestScore >= 10 ? best : null;
}

function isStockRowRelevant(row, term, records, formulas) {
  const haystack = `${row.name} ${row.ean || ''}`;
  if (matches(term, haystack)) return true;

  for (const record of records) {
    const base = record.base_name || record.family?.replaceAll('-', ' ') || '';
    if (base && matches(base, row.name)) return true;
  }

  for (const formula of formulas) {
    for (const part of splitFormula(formula)) {
      if (matches(ingredientCore(part), row.name)) return true;
    }
  }
  return false;
}

function isGeneric(record) {
  const kind = norm(record.kind || '');
  if (kind) return kind.includes('generic');
  const active = norm(record.active || '');
  const name = norm(record.name || '');
  return Boolean(active && name.startsWith(active));
}

async function fetchText(url, label) {
  const response = await fetch(url, {headers: {'user-agent': `Mozilla/5.0 ConsultaMed/${APP_VERSION}`, 'accept': 'text/html,application/json'}});
  if (!response.ok) throw new Error(`${label} respondeu ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_CR_BYTES) throw new Error(`${label}: resposta muito grande.`);
  return text;
}

async function safeFetch(input, init = {}, follow = true) {
  let url = new URL(input);
  validateMBILEURL(url);
  let options = {...init, redirect: 'manual'};

  for (let i = 0; i < 5; i++) {
    const response = await fetch(url, options);
    if (!follow || ![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    url = new URL(location, url);
    validateMBILEURL(url);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && options.method === 'POST')) {
      options = {headers: options.headers, method: 'GET', redirect: 'manual'};
    }
  }
  throw new Error('Muitos redirecionamentos no link do MBILE.');
}

function normalizeMBILEUrl(value) {
  let v = String(value || '').trim().replace(/^[<>"']+|[<>"']+$/g, '');
  v = v.replace(/^https;\/*/i, 'https://');
  const repeated = v.match(/^(https:\/\/urlshort\.at\/[a-zA-Z0-9]+?)(?:h?ttps?[:;]\/\/urlshort\.at\/).+$/i);
  if (repeated) v = repeated[1];
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  const url = new URL(v);
  validateMBILEURL(url);
  return url.toString();
}

function validateMBILEURL(url) {
  if (url.protocol !== 'https:' || url.username || url.password || !isAllowedMBILEHost(url.hostname)) throw new Error('URL do MBILE inválida.');
}

function isAllowedMBILEHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'urlshort.at' || h.endsWith('.trycloudflare.com');
}

function cleanCRUrl(value) {
  try {
    const url = new URL(value, CR);
    if (url.protocol !== 'https:' || url.hostname !== 'consultaremedios.com.br') return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function* walkObjects(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* walkObjects(item);
  } else if (value && typeof value === 'object') {
    yield value;
    for (const item of Object.values(value)) yield* walkObjects(item);
  }
}

function valueFromProps(props, target) {
  for (const prop of props) {
    if (prop && typeof prop === 'object' && norm(prop.name) === target) return typeof prop.value === 'string' ? prop.value : '';
  }
  return '';
}

function mergeRecord(oldRecord, nextRecord) {
  if (!oldRecord) return nextRecord;
  const out = {...oldRecord};
  for (const [key, value] of Object.entries(nextRecord)) if (value !== '' && value !== null && value !== undefined) out[key] = value;
  return out;
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(text) {
  return String(text || '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g)?.join(' ') || '';
}

function matches(term, text) {
  const target = norm(text);
  return norm(term).split(' ').filter(Boolean).every((token) => target.includes(token));
}

function extractCookies(headers) {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

function mergeCookies(a, b) {
  const map = new Map();
  for (const piece of `${a || ''}; ${b || ''}`.split(';')) {
    const trimmed = piece.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [name, ...rest] = trimmed.split('=');
    map.set(name, rest.join('='));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function safeMessage(error) {
  return String(error?.message || error || 'Erro inesperado').slice(0, 240);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}
  });
}
