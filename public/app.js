const $ = (id) => document.getElementById(id);

const configPanel = $('configPanel');
const searchPanel = $('searchPanel');
const mbileUrl = $('mbileUrl');
const mbileCode = $('mbileCode');
const query = $('query');
const onlyStock = $('onlyStock');
const statusEl = $('status');
const resultsEl = $('results');
const detailsDialog = $('detailsDialog');

let lastRecords = [];
let usingStock = false;

mbileUrl.value = localStorage.getItem('consultamed.mbileUrl') || '';
mbileCode.value = sessionStorage.getItem('consultamed.mbileCode') || '';

function setStatus(text = '', error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function showSearch() {
  configPanel.classList.add('hidden');
  searchPanel.classList.remove('hidden');
  query.focus();
}

function showConfig() {
  searchPanel.classList.add('hidden');
  configPanel.classList.remove('hidden');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function stockLine(record) {
  if (!record.stock) return usingStock ? '<p class="muted">Estoque: —</p>' : '';
  return `<p class="stock-positive">Estoque: ${esc(record.stock.qty)} ${esc(record.stock.price || '')}</p>`;
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
    card.innerHTML = `
      <h2>${esc(record.name)}</h2>
      ${record.active ? `<p class="muted">${esc(record.active)}</p>` : ''}
      ${stockLine(record)}
      <div class="card-actions"><button type="button" data-details>Informações</button></div>
    `;
    card.querySelector('[data-details]').addEventListener('click', () => showDetails(record));
    resultsEl.appendChild(card);
  }
}

function showDetails(record) {
  $('detailsTitle').textContent = record.name;
  const family = record.family || '';
  const bula = family ? `https://consultaremedios.com.br/${encodeURIComponent(family)}/bula` : record.url;
  $('detailsBody').innerHTML = `
    ${record.active ? `<p><strong>Princípio ativo:</strong> ${esc(record.active)}</p>` : ''}
    ${record.brand ? `<p><strong>Marca/Fabricante:</strong> ${esc(record.brand)}</p>` : ''}
    ${record.ean ? `<p><strong>EAN:</strong> ${esc(record.ean)}</p>` : ''}
    ${record.stock ? `<p><strong>Estoque:</strong> ${esc(record.stock.qty)} ${esc(record.stock.price || '')}</p>` : ''}
    <p><a href="${esc(record.url)}" target="_blank" rel="noopener">Abrir no Consulta Remédios</a></p>
    ${family ? `<p><a href="${esc(bula)}" target="_blank" rel="noopener">Bula</a></p>` : ''}
    ${family ? `<p><a href="${esc(bula)}#posologia-como-usar" target="_blank" rel="noopener">Como usar</a></p>` : ''}
  `;
  detailsDialog.showModal();
}

async function doSearch() {
  const term = query.value.trim();
  if (term.length < 2) {
    setStatus('Digite pelo menos 2 caracteres.', true);
    return;
  }

  setStatus('Pesquisando…');
  resultsEl.innerHTML = '';
  $('searchBtn').disabled = true;

  try {
    const payload = {
      term,
      mbileUrl: usingStock ? mbileUrl.value.trim() : '',
      mbileCode: usingStock ? mbileCode.value.trim() : ''
    };

    const response = await fetch('/api/search', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Falha na pesquisa.');

    lastRecords = data.records || [];
    render(lastRecords);
    const notes = Array.isArray(data.notes) ? data.notes.filter(Boolean) : [];
    setStatus(`${lastRecords.length} resultados${notes.length ? ' · ' + notes.join(' · ') : ''}`);
  } catch (error) {
    setStatus(error.message || 'Erro na pesquisa.', true);
  } finally {
    $('searchBtn').disabled = false;
  }
}

$('saveConnection').addEventListener('click', () => {
  const url = mbileUrl.value.trim();
  const code = mbileCode.value.trim();
  if (!url || !code) {
    alert('Informe a URL e o código do MBILE.');
    return;
  }
  localStorage.setItem('consultamed.mbileUrl', url);
  sessionStorage.setItem('consultamed.mbileCode', code);
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

$('configBtn').addEventListener('click', showConfig);
$('searchBtn').addEventListener('click', doSearch);
query.addEventListener('keydown', (event) => { if (event.key === 'Enter') doSearch(); });
onlyStock.addEventListener('change', () => render(lastRecords));
$('closeDetails').addEventListener('click', () => detailsDialog.close());

if (mbileUrl.value && mbileCode.value) {
  usingStock = true;
  showSearch();
}
