const CR = 'https://consultaremedios.com.br';
const APP_VERSION = '2.5';
const MAX_CR_BYTES = 12_000_000;

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const term = String(body?.term || '').trim().slice(0, 180);
    const baseUrl = String(body?.baseUrl || '').trim();
    const baseCode = String(body?.baseCode || '').trim();
    if (term.length < 2) return json({error: 'Pesquisa muito curta.'}, 400);
    if (!baseUrl || !baseCode) return json({records: [], notes: []});

    const [baseResult, crResult] = await Promise.allSettled([
      searchBASE(baseUrl, baseCode, term),
      searchCR(term)
    ]);

    if (baseResult.status !== 'fulfilled') throw baseResult.reason;

    const rows = baseResult.value;
    const crRecords = crResult.status === 'fulfilled' ? crResult.value : [];
    const records = rows.map((row) => {
      const key = relationKey(row);
      const ranked = rankCRMatches(row, crRecords);
      const trusted = confidentCRMatch(ranked);
      const candidates = ranked.slice(0, 10).map(({record}) => relationCandidate(record));
      if (trusted) {
        return {
          ...trusted,
          stock: row,
          relationKey: key,
          relationCandidates: candidates
        };
      }

      return {
        source: 'BASE',
        name: row.name,
        active: '',
        brand: '',
        ean: row.ean || '',
        family: '',
        base_name: row.name,
        kind: '',
        image: '',
        url: '',
        stock: row,
        relationKey: key,
        relationCandidates: candidates
      };
    });

    const unique = new Map();
    for (const record of records) {
      const key = record.stock?.id || record.ean || norm(record.name);
      if (!unique.has(key)) unique.set(key, record);
    }

    return json({records: [...unique.values()], notes: []});
  } catch (error) {
    return json({error: safeMessage(error)}, 500);
  }
}

async function searchBASE(link, code, term) {
  const login = await loginBASE(link, code);
  const response = await safeFetch(`${login.base}/produtos?q=${encodeURIComponent(term)}`, {
    headers: {
      'cookie': login.cookie,
      'user-agent': `Mozilla/5.0 ConsultaMed/${APP_VERSION}`
    }
  }, true);
  return parseStock(await response.text());
}

async function loginBASE(link, code) {
  const initial = await safeFetch(normalizeBASEUrl(link), {
    headers: {'user-agent': `Mozilla/5.0 ConsultaMed/${APP_VERSION}`}
  }, true);
  const initialHtml = await initial.text();
  if (!/name=["']codigo["']/i.test(initialHtml)) throw new Error('Autenticação da BASE não encontrada.');

  const base = new URL(initial.url).origin;
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
  if (!cookie) throw new Error('Sessão da BASE não foi criada.');
  return {base, cookie};
}

function parseStock(html) {
  if (/name=["']codigo["']/i.test(html)) throw new Error('Código incorreto ou sessão encerrada.');
  if (!/name=["']q["']/i.test(html)) throw new Error('Página de produtos da BASE não encontrada.');

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
    const qty = stock ? Number(stock[1].replaceAll('.', '').replace(',', '.')) : 0;
    const priceMatch = block.match(/<span\b[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    rows.push({
      id,
      name,
      ean: bar?.[1] || '',
      qty: Number.isFinite(qty) ? qty : 0,
      price: priceMatch ? stripTags(priceMatch[1]).trim() : ''
    });
  }
  return rows;
}

async function searchCR(term) {
  const response = await fetch(`${CR}/busca?termo=${encodeURIComponent(term)}`, {
    headers: {
      'user-agent': `Mozilla/5.0 ConsultaMed/${APP_VERSION}`,
      'accept': 'text/html,application/json'
    }
  });
  if (!response.ok) return [];
  const html = await response.text();
  if (html.length > MAX_CR_BYTES) return [];
  return parseCR(html).filter((record) => matches(term, [record.name, record.active, record.brand, record.ean].join(' ')));
}

function parseCR(html) {
  const records = [];
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

      records.push({
        source: 'CR',
        url: href,
        name,
        active: String(active || ''),
        brand: String(brand || ''),
        ean,
        family,
        base_name: String(obj.alternateName || name.split(' ')[0] || family.replaceAll('-', ' ')),
        kind: '',
        image: cleanImageUrl(imageFromObject(obj.image))
      });
    }
  }

  const unique = new Map();
  for (const record of records) if (!unique.has(record.url)) unique.set(record.url, record);
  return [...unique.values()];
}

function relationKey(row) {
  if (row.id) return `id:${row.id}`;
  if (row.ean) return `ean:${row.ean}`;
  return `name:${norm(row.name)}`;
}

const RELATION_STOP_TOKENS = new Set([
  'com', 'caixa', 'cx', 'c', 'contendo', 'comprimido', 'comprimidos', 'comp',
  'capsula', 'capsulas', 'cap', 'frasco', 'fr', 'blister', 'blisteres', 'unidade',
  'unidades', 'revestido', 'revestidos', 'uso', 'oral', 'adulto', 'pediatrico'
]);

function relationCandidate(record) {
  return {
    source: 'CR',
    url: record.url,
    name: record.name,
    active: record.active,
    brand: record.brand,
    ean: record.ean,
    family: record.family,
    base_name: record.base_name,
    kind: record.kind,
    image: record.image
  };
}

function rankCRMatches(row, records) {
  const rowName = norm(row.name);
  if (!rowName) return [];
  const rowTokens = meaningfulTokens(row.name);
  const rowPresentation = presentationTokens(row.name);
  const scored = [];

  for (const record of records) {
    const recordName = norm(record.name);
    if (!recordName) continue;
    const recordTokens = meaningfulTokens(record.name);
    const recordPresentation = presentationTokens(record.name);
    const base = norm(record.base_name || record.family?.replaceAll('-', ' ') || '');
    const baseTokens = meaningfulTokens(base);
    const overlap = intersectionSize(rowTokens, recordTokens);
    const union = new Set([...rowTokens, ...recordTokens]).size || 1;
    const exactEan = Boolean(record.ean && row.ean && record.ean === row.ean);
    const exactName = recordName === rowName;
    let score = overlap * 12 + Math.round((overlap / union) * 40);

    if (exactEan) score += 1000;
    if (exactName) score += 300;
    if (rowName.includes(recordName) || recordName.includes(rowName)) score += 55;
    if (firstMeaningfulToken(row.name) === firstMeaningfulToken(record.name)) score += 28;
    if (base && rowName.startsWith(base)) score += 42;
    if (baseTokens.size && [...baseTokens].every((token) => rowTokens.has(token))) score += 32;

    const presentation = comparePresentation(rowPresentation, recordPresentation);
    score += presentation.score;

    if (score < 34) continue;
    scored.push({score, record, exactEan, exactName, presentationExact: presentation.exact});
  }

  scored.sort((a, b) => b.score - a.score || norm(a.record.name).localeCompare(norm(b.record.name), 'pt-BR'));
  return scored;
}

function confidentCRMatch(ranked) {
  const first = ranked[0];
  if (!first) return null;
  if (first.exactEan || first.exactName) return first.record;

  const second = ranked[1];
  const gap = second ? first.score - second.score : Infinity;
  if (!second && first.score >= 55) return first.record;
  if (first.score >= 105 && gap >= 5) return first.record;
  if (first.score >= 78 && gap >= 10) return first.record;
  if (first.presentationExact && first.score >= 70 && gap >= 7) return first.record;
  return null;
}

function meaningfulTokens(value) {
  return new Set(norm(value).split(' ').filter((token) => (
    token && !RELATION_STOP_TOKENS.has(token) && !/^\d+$/.test(token)
  )));
}

function firstMeaningfulToken(value) {
  return [...meaningfulTokens(value)][0] || '';
}

function presentationTokens(value) {
  const clean = String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/,/g, '.');
  const tokens = new Set();
  for (const match of clean.matchAll(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|ui|u\/g|%)\b/g)) {
    tokens.add(match[0].replace(/\s+/g, ''));
  }
  for (const match of clean.matchAll(/\b(?:c|cx|com|contendo|x)\s*(\d{1,3})\b|\b(\d{1,3})\s*(?:comprimidos?|capsulas?|drageas?|saches?|ampolas?)\b/g)) {
    tokens.add(`qtd:${match[1] || match[2]}`);
  }
  return tokens;
}

function comparePresentation(a, b) {
  if (!a.size || !b.size) return {score: 0, exact: false};
  const overlap = intersectionSize(a, b);
  const dosesA = new Set([...a].filter((value) => !value.startsWith('qtd:')));
  const dosesB = new Set([...b].filter((value) => !value.startsWith('qtd:')));
  const packsA = new Set([...a].filter((value) => value.startsWith('qtd:')));
  const packsB = new Set([...b].filter((value) => value.startsWith('qtd:')));
  const doseConflict = dosesA.size && dosesB.size && !intersectionSize(dosesA, dosesB);
  const packConflict = packsA.size && packsB.size && !intersectionSize(packsA, packsB);
  if (doseConflict || packConflict) return {score: -120, exact: false};
  if (a.size === b.size && overlap === a.size) return {score: 58, exact: true};
  if (overlap) return {score: 22, exact: false};
  return {score: -120, exact: false};
}

function intersectionSize(a, b) {
  let size = 0;
  for (const value of a) if (b.has(value)) size += 1;
  return size;
}

async function safeFetch(input, init = {}, follow = true) {
  let url = new URL(input);
  validateBASEURL(url);
  let options = {...init, redirect: 'manual'};

  for (let i = 0; i < 5; i++) {
    const response = await fetch(url, options);
    if (!follow || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    url = new URL(location, url);
    validateBASEURL(url);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && options.method === 'POST')) {
      options = {headers: options.headers, method: 'GET', redirect: 'manual'};
    }
  }
  throw new Error('Muitos redirecionamentos no link da BASE.');
}

function normalizeBASEUrl(value) {
  let v = String(value || '').trim().replace(/^[<>"']+|[<>"']+$/g, '');
  v = v.replace(/^https;\/*/i, 'https://');
  const repeated = v.match(/^(https:\/\/urlshort\.at\/[a-zA-Z0-9]+?)(?:h?ttps?[:;]\/\/urlshort\.at\/).+$/i);
  if (repeated) v = repeated[1];
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  const url = new URL(v);
  validateBASEURL(url);
  return url.toString();
}

function validateBASEURL(url) {
  if (url.protocol !== 'https:' || url.username || url.password || !isAllowedBASEHost(url.hostname)) {
    throw new Error('URL da BASE inválida.');
  }
}

function isAllowedBASEHost(hostname) {
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
    if (prop && typeof prop === 'object' && norm(prop.name) === target) {
      return typeof prop.value === 'string' ? prop.value : '';
    }
  }
  return '';
}

function stripTags(html) {
  return decodeEntities(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
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
