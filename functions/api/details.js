const CR = 'https://consultaremedios.com.br';
const MAX_BYTES = 12_000_000;

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const url = cleanProductUrl(body?.url);
    const family = cleanFamily(body?.family);
    if (!url) return json({error: 'URL do medicamento inválida.'}, 400);

    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 ConsultaMed/1.5',
        'accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) return json({error: `Consulta Remédios respondeu ${response.status}.`}, 502);

    const html = await response.text();
    if (html.length > MAX_BYTES) return json({error: 'Resposta muito grande.'}, 502);

    const image = extractImage(html);
    const presentations = extractPresentations(html, family);
    return json({image, presentations});
  } catch (error) {
    return json({error: String(error?.message || error || 'Erro inesperado').slice(0, 220)}, 500);
  }
}

function cleanProductUrl(value) {
  try {
    const url = new URL(String(value || ''), CR);
    if (url.protocol !== 'https:' || url.hostname !== 'consultaremedios.com.br' || !url.pathname.endsWith('/p')) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function cleanFamily(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 100);
}

function extractImage(html) {
  const metaPatterns = [
    /<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i,
    /<meta\b[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i
  ];

  for (const pattern of metaPatterns) {
    const match = html.match(pattern);
    const clean = cleanImageUrl(match?.[1]);
    if (clean) return clean;
  }

  for (const m of html.matchAll(/<script\b[^>]*type=["'][^"']*json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let payload;
    try { payload = JSON.parse(m[1].trim()); } catch { continue; }
    for (const obj of walkObjects(payload)) {
      const clean = cleanImageUrl(imageFromObject(obj?.image));
      if (clean) return clean;
    }
  }

  return '';
}

function extractPresentations(html, family) {
  if (!family) return [];
  const prefix = `/${family}/`;
  const map = new Map();

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1]);
    let url;
    try { url = new URL(href, CR); } catch { continue; }
    if (url.hostname !== 'consultaremedios.com.br' || !url.pathname.startsWith(prefix) || !url.pathname.endsWith('/p')) continue;

    const name = stripTags(m[2]);
    if (!name || name.length < 3 || name.length > 180) continue;
    map.set(url.toString(), {name, url: url.toString()});
    if (map.size >= 40) break;
  }

  return [...map.values()];
}

function imageFromObject(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = imageFromObject(item);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') return value.url || value.contentUrl || value.thumbnailUrl || '';
  return '';
}

function cleanImageUrl(value) {
  try {
    const url = new URL(decodeEntities(String(value || '')), CR);
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}
  });
}
