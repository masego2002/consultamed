const $ = (id) => document.getElementById(id);

const configPanel = $('configPanel');
const searchPanel = $('searchPanel');
const baseUrl = $('baseUrl');
const baseCode = $('baseCode');
const query = $('query');
const onlyStock = $('onlyStock');
const statusEl = $('status');
const resultsEl = $('results');
const detailsDialog = $('detailsDialog');
const searchBtn = $('searchBtn');
const otherSearchBtn = $('otherSearchBtn');
const cancelSearchBtn = $('cancelSearch');
const searchBtnText = $('searchBtnText');
const searchBtnSpinner = $('searchBtnSpinner');
const otherSearchBtnText = $('otherSearchBtnText');
const otherSearchBtnSpinner = $('otherSearchBtnSpinner');
const searchLoader = $('searchLoader');

let lastRecords = [];
let usingStock = false;
let detailsRequestToken = 0;
let searchController = null;
let searchSequence = 0;

baseUrl.value = localStorage.getItem('consultamed.baseUrl') || '';
baseCode.value = sessionStorage.getItem('consultamed.baseCode') || '';
onlyStock.disabled = true;

function setStatus(text = '', error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function setSearching(searching, mode = 'base') {
  const baseSearching = searching && mode === 'base';
  const othersSearching = searching && mode === 'others';
  searchBtnText.textContent = baseSearching ? 'Pesquisando..' : 'Pesquisar';
  otherSearchBtnText.textContent = othersSearching ? 'Pesquisando..' : 'Outros';
  searchBtnSpinner.classList.toggle('hidden', !baseSearching);
  otherSearchBtnSpinner.classList.toggle('hidden', !othersSearching);
  cancelSearchBtn.classList.toggle('hidden', !searching);
  searchLoader.classList.toggle('hidden', !searching);
  searchBtn.setAttribute('aria-busy', baseSearching ? 'true' : 'false');
  otherSearchBtn.setAttribute('aria-busy', othersSearching ? 'true' : 'false');
}

function showSearch({focus = true} = {}) {
  configPanel.classList.add('hidden');
  searchPanel.classList.remove('hidden');
  $('configBtn').setAttribute('aria-pressed', 'false');
  if (focus) query.focus();
}

function showConfig() {
  searchPanel.classList.add('hidden');
  configPanel.classList.remove('hidden');
  $('configBtn').setAttribute('aria-pressed', 'true');
}

function toggleConfig() {
  if (configPanel.classList.contains('hidden')) {
    showConfig();
  } else {
    showSearch({focus: false});
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function stockLine(record) {
  const qty = Number(record?.stock?.qty);
  if (!Number.isFinite(qty) || qty < 1) return '';
  return `<p class="stock-positive">Estoque: ${esc(record.stock.qty)}${record.stock.price ? ` · ${esc(record.stock.price)}` : ''}</p>`;
}

function activeButton(active, className = 'active-link') {
  if (!active) return '';
  return `<button type="button" class="${className}" data-search-active="${esc(active)}">${esc(active)}</button>`;
}

function wireActiveSearch(root) {
  root.querySelectorAll('[data-search-active]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const active = button.dataset.searchActive || button.textContent || '';
      searchByFormula(active);
    });
  });
}

function render(records) {
  const filtered = records.filter((r) => !onlyStock.checked || (r.stock && Number(r.stock.qty) >= 1));
  resultsEl.innerHTML = '';
  if (!filtered.length) {
    resultsEl.innerHTML = '<div class="card muted">Nenhum resultado.</div>';
    return;
  }

  for (const record of filtered) {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.innerHTML = `
      <h2>${esc(record.name)}</h2>
      ${stockLine(record)}
      ${record.active ? `<p class="muted active-row">${activeButton(record.active)}</p>` : ''}
      <div class="card-actions"><button type="button" data-details>Informações</button></div>
    `;

    card.querySelector('[data-details]').addEventListener('click', (event) => {
      event.stopPropagation();
      showDetails(record);
    });
    wireActiveSearch(card);

    let lastCardClick = 0;
    card.addEventListener('click', (event) => {
      if (event.target.closest('button, a')) return;
      const now = Date.now();
      if (now - lastCardClick <= 420) {
        lastCardClick = 0;
        showDetails(record);
      } else {
        lastCardClick = now;
      }
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') showDetails(record);
    });

    resultsEl.appendChild(card);
  }
}

function localPresentations(record) {
  const seen = new Set();
  return lastRecords
    .filter((item) => record.family && item.family === record.family)
    .filter((item) => {
      const key = String(item.name || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({name: item.name, url: item.url || ''}));
}

function renderPresentations(items = [], family = '') {
  const target = $('detailsPresentations');
  if (!target) return;

  const seen = new Set();
  const clean = items.filter((item) => {
    const name = String(item?.name || '').trim();
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  }).slice(0, 30);

  if (!clean.length) {
    target.innerHTML = family
      ? `<a href="https://consultaremedios.com.br/${encodeURIComponent(family)}" target="_blank" rel="noopener">Ver apresentações no Consulta Remédios</a>`
      : '<span class="muted">Apresentações não encontradas.</span>';
    return;
  }

  target.innerHTML = `<ul class="presentations-list">${clean.map((item) => (
    `<li>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.name)}</a>` : esc(item.name)}</li>`
  )).join('')}</ul>`;
}

function showDetails(record) {
  const token = ++detailsRequestToken;
  $('detailsTitle').textContent = record.name;
  const family = record.family || '';
  const bula = family ? `https://consultaremedios.com.br/${encodeURIComponent(family)}/bula` : record.url;
  const localItems = localPresentations(record);

  $('detailsBody').innerHTML = `
    <div id="detailsImageWrap" class="medicine-image-wrap ${record.image ? '' : 'hidden'}">
      <img id="detailsImage" class="medicine-image" ${record.image ? `src="${esc(record.image)}"` : ''} alt="${esc(record.name)}" loading="lazy">
    </div>
    ${record.active ? `<p><strong>Princípio ativo:</strong> ${activeButton(record.active, 'active-link details-active-link')}</p>` : ''}
    ${record.brand ? `<p><strong>Marca/Fabricante:</strong> ${esc(record.brand)}</p>` : ''}
    ${record.ean ? `<p><strong>EAN:</strong> ${esc(record.ean)}</p>` : ''}
    ${record.stock && Number(record.stock.qty) >= 1 ? `<p><strong>Estoque:</strong> ${esc(record.stock.qty)}${record.stock.price ? ` · ${esc(record.stock.price)}` : ''}</p>` : ''}
    <div class="details-section">
      <strong>Apresentações:</strong>
      <div id="detailsPresentations" class="details-presentations"></div>
    </div>
    ${record.url ? `<p><a href="${esc(record.url)}" target="_blank" rel="noopener">Abrir no Consulta Remédios</a></p>` : ''}
    ${family ? `<p><a href="${esc(bula)}" target="_blank" rel="noopener">Bula</a></p>` : ''}
    ${family ? `<p><a href="${esc(bula)}#posologia-como-usar" target="_blank" rel="noopener">Como usar</a></p>` : ''}
  `;

  renderPresentations(localItems, family);
  wireActiveSearch($('detailsBody'));
  detailsDialog.showModal();
  loadRemoteDetails(record, token, localItems);
}

async function loadRemoteDetails(record, token, localItems) {
  if (!record?.url || record.source !== 'CR') return;
  try {
    const response = await fetch('/api/details', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({url: record.url, family: record.family || ''})
    });
    if (!response.ok) return;
    const data = await response.json();
    if (token !== detailsRequestToken || !detailsDialog.open) return;

    if (data.image) {
      const image = $('detailsImage');
      const wrap = $('detailsImageWrap');
      if (image && wrap) {
        image.src = data.image;
        wrap.classList.remove('hidden');
      }
    }

    const remoteItems = Array.isArray(data.presentations) ? data.presentations : [];
    renderPresentations([...localItems, ...remoteItems], record.family || '');
  } catch (_) {
  }
}

async function runSearch(term, {formula = '', mode = 'base'} = {}) {
  const cleanTerm = String(term || '').trim();
  if (cleanTerm.length < 2) {
    setStatus('Digite pelo menos 2 caracteres.', true);
    return;
  }

  if (searchController) searchController.abort();
  const controller = new AbortController();
  const sequence = ++searchSequence;
  searchController = controller;

  setStatus('');
  resultsEl.innerHTML = '';
  setSearching(true, mode);

  try {
    const payload = {
      term: cleanTerm,
      formula: String(formula || '').trim(),
      mode,
      baseUrl: usingStock ? baseUrl.value.trim() : '',
      baseCode: usingStock ? baseCode.value.trim() : ''
    };

    const endpoint = mode === 'others' ? '/api/search' : '/api/base-search';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const data = await response.json();
    if (sequence !== searchSequence) return;
    if (!response.ok) throw new Error(data.error || 'Falha na pesquisa.');

    lastRecords = data.records || [];
    render(lastRecords);
    const visibleCount = lastRecords.filter((r) => !onlyStock.checked || (r.stock && Number(r.stock.qty) >= 1)).length;
    const notes = Array.isArray(data.notes) ? data.notes.filter(Boolean) : [];
    setStatus(`${visibleCount} resultados${formula ? ' da mesma fórmula' : ''}${notes.length ? ' · ' + notes.join(' · ') : ''}`);
  } catch (error) {
    if (error?.name === 'AbortError' || sequence !== searchSequence) return;
    setStatus(error.message || 'Erro na pesquisa.', true);
  } finally {
    if (sequence === searchSequence) {
      searchController = null;
      setSearching(false);
    }
  }
}

function cancelSearch() {
  if (!searchController) return;
  searchSequence += 1;
  searchController.abort();
  searchController = null;
  setSearching(false);
  if (lastRecords.length) {
    render(lastRecords);
    const visibleCount = lastRecords.filter((r) => !onlyStock.checked || (r.stock && Number(r.stock.qty) >= 1)).length;
    setStatus(`${visibleCount} resultados`);
  } else {
    resultsEl.innerHTML = '';
    setStatus('');
  }
}

function doSearch() {
  runSearch(query.value, {mode: 'base'});
}

function doOtherSearch() {
  runSearch(query.value, {mode: 'others'});
}

function searchByFormula(active) {
  const formula = String(active || '').trim();
  if (formula.length < 2) return;
  if (detailsDialog.open) detailsDialog.close();
  showSearch({focus: false});
  query.value = formula;
  runSearch(formula, {formula, mode: 'others'});
}

$('saveConnection').addEventListener('click', () => {
  const url = baseUrl.value.trim();
  const code = baseCode.value.trim();
  if (!url || !code) {
    alert('Informe a URL e o código da BASE.');
    return;
  }
  localStorage.setItem('consultamed.baseUrl', url);
  sessionStorage.setItem('consultamed.baseCode', code);
  usingStock = true;
  onlyStock.disabled = false;
  showSearch();
});

$('skipConnection').addEventListener('click', () => {
  usingStock = false;
  onlyStock.checked = false;
  onlyStock.disabled = true;
  showSearch();
});

$('configBtn').addEventListener('click', toggleConfig);
searchBtn.addEventListener('click', doSearch);
otherSearchBtn.addEventListener('click', doOtherSearch);
cancelSearchBtn.addEventListener('click', cancelSearch);
query.addEventListener('keydown', (event) => { if (event.key === 'Enter') doSearch(); });
onlyStock.addEventListener('change', () => {
  render(lastRecords);
  if (lastRecords.length) {
    const visibleCount = lastRecords.filter((r) => !onlyStock.checked || (r.stock && Number(r.stock.qty) >= 1)).length;
    setStatus(`${visibleCount} resultados`);
  }
});
$('closeDetails').addEventListener('click', () => detailsDialog.close());

detailsDialog.addEventListener('click', (event) => {
  if (event.target === detailsDialog) detailsDialog.close();
});

if (baseUrl.value && baseCode.value) {
  usingStock = true;
  onlyStock.disabled = false;
  showSearch({focus: false});
}
