/* Concordance — scan a QR label, find out what is in the box.
 *
 * Every URL here is relative and routing is done with the hash, so the app
 * works unchanged whether it is served at the domain root or proxied under
 * some arbitrary prefix. Nothing knows its own mount point. */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ID_RE = /^(?:[0-9A-Z]{1,5}-)?[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

/* ---------- api ---------- */

class AuthError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`./api/${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('not signed in');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

/* ---------- camera ---------- */

// Chrome has BarcodeDetector natively; Safari does not, so jsQR reads frames
// off a canvas instead. Same interface either way.
async function makeDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (videoEl) => {
          const found = await det.detect(videoEl);
          return found[0]?.rawValue ?? null;
        };
      }
    } catch { /* fall through to jsQR */ }
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (videoEl) => {
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (!w || !h) return null;
    // Downscale: jsQR gets no better at full sensor resolution, just slower.
    const scale = Math.min(1, 640 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height)?.data ?? null;
  };
}

let activeStream = null;
function stopCamera() {
  activeStream?.getTracks().forEach((t) => t.stop());
  activeStream = null;
}

/* ---------- routing ---------- */

const routes = {
  '#/scan': renderScan,
  '#/search': renderSearch,
  '#/boxes': renderBoxes,
  '#/unclaimed': renderUnclaimed,
};

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  stopCamera();
  const hash = location.hash || '#/scan';
  for (const tab of document.querySelectorAll('.tab')) {
    const on = hash === tab.dataset.route;
    tab.setAttribute('aria-current', on ? 'page' : 'false');
  }
  try {
    if (hash.startsWith('#/box/')) return await renderBox(decodeURIComponent(hash.slice(6)));
    await (routes[hash] ?? renderScan)();
  } catch (err) {
    if (err instanceof AuthError) return renderSignIn();
    view.innerHTML = `<div class="card"><p class="notice notice-warn">${esc(err.message)}</p></div>`;
  }
}

/* ---------- sign in ---------- */

function setChrome(signedIn) {
  $('#topbar').hidden = !signedIn;
  $('#tabbar').hidden = !signedIn;
}

function renderSignIn() {
  stopCamera();
  setChrome(false);
  view.className = 'signin';
  view.innerHTML = `
    <h2>Concordance</h2>
    <p class="muted">Scan a label, find out what is in the box.</p>
    <form class="card" id="signin-form" style="margin-top:16px">
      <div class="field">
        <label class="field-label" for="password">Password</label>
        <input class="input" type="password" id="password" autocomplete="current-password" required>
      </div>
      <button class="btn btn-primary btn-wide" type="submit">Sign in</button>
      <p class="notice notice-warn hidden" id="signin-error" style="margin-top:12px"></p>
    </form>`;

  $('#signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#signin-error');
    err.classList.add('hidden');
    try {
      await api('session', { method: 'POST', body: { password: $('#password').value } });
      view.className = 'shell';
      setChrome(true);
      go('#/scan');
    } catch (ex) {
      err.textContent = ex instanceof AuthError ? 'Wrong password.' : ex.message;
      err.classList.remove('hidden');
    }
  });
}

/* ---------- scan ---------- */

async function renderScan() {
  view.innerHTML = `
    <p class="legend">Scan</p>
    <div class="scanstage"><video id="cam" playsinline muted></video><div class="reticle"><div></div></div></div>
    <p class="scanstatus" id="scanstatus">Starting camera…</p>
    <div class="card">
      <p class="legend">Or type the ID</p>
      <form id="manual-form" class="btn-row">
        <input class="input idtext" id="manual" placeholder="ATTIC-K7M2-9XQZ"
               autocapitalize="characters" autocomplete="off" spellcheck="false" style="flex:1;min-width:180px">
        <button class="btn" type="submit">Open</button>
      </form>
      <p class="muted" style="margin:8px 0 0">The ID is printed beside every QR code, for when a label is too scuffed to scan.</p>
    </div>`;

  $('#manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('#manual').value.trim().toUpperCase();
    if (id) go(`#/box/${encodeURIComponent(id)}`);
  });

  const status = $('#scanstatus');
  const video = $('#cam');

  if (!navigator.mediaDevices?.getUserMedia) {
    status.innerHTML = window.isSecureContext
      ? 'This browser has no camera API. Type the ID instead.'
      : '<span style="color:var(--caution)">The camera needs HTTPS. Over plain HTTP the browser blocks it — type the ID, or reach this page over https.</span>';
    return;
  }

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false,
    });
  } catch (err) {
    status.innerHTML = err.name === 'NotAllowedError'
      ? 'Camera permission denied. Allow it in site settings, or type the ID.'
      : `Camera unavailable (${esc(err.name)}). Type the ID instead.`;
    return;
  }

  video.srcObject = activeStream;
  await video.play().catch(() => {});
  status.textContent = 'Point at a label.';

  const decode = await makeDecoder();
  const started = activeStream;
  let busy = false;

  const tick = async () => {
    // Bail the moment the view changed under us.
    if (activeStream !== started) return;
    if (!busy) {
      busy = true;
      try {
        const raw = await decode(video);
        if (raw) {
          const id = raw.trim().toUpperCase();
          if (ID_RE.test(id)) {
            navigator.vibrate?.(40);
            stopCamera();
            return go(`#/box/${encodeURIComponent(id)}`);
          }
          status.textContent = 'That QR code is not a Concordance label.';
        }
      } catch { /* a dropped frame is not worth reporting */ }
      busy = false;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- box ---------- */

function itemRow(value = '') {
  return `<li><input class="input item" value="${esc(value)}" placeholder="One thing in the box">
    <button class="btn item-remove" type="button" aria-label="Remove">&minus;</button></li>`;
}

async function renderBox(rawId) {
  const id = rawId.toUpperCase();
  if (!ID_RE.test(id)) {
    view.innerHTML = `<div class="empty"><h2>Not a label</h2>
      <p class="muted"><span class="idtext">${esc(id)}</span> is not a Concordance ID.</p>
      <button class="btn" type="button" onclick="location.hash='#/scan'">Back to scanning</button></div>`;
    return;
  }

  const data = await api(`labels/${encodeURIComponent(id)}`);
  const box = data.box ?? { name: '', location: '', notes: '', items: [] };
  const claimed = data.claimed;

  view.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <span class="idtext">${esc(id)}</span>
      <span class="chip ${claimed ? '' : 'chip-warn'}">${claimed ? 'claimed' : data.printed ? 'printed, empty' : 'unknown label'}</span>
    </div>
    ${claimed ? '' : `<p class="notice" style="margin-bottom:12px">Nothing recorded against this label yet. Fill it in and it becomes a box.</p>`}
    <form class="card" id="box-form">
      <div class="field">
        <label class="field-label" for="name">What is it</label>
        <input class="input" id="name" value="${esc(box.name)}" placeholder="Winter clothes">
      </div>
      <div class="field">
        <label class="field-label" for="location">Where it lives</label>
        <input class="input" id="location" value="${esc(box.location)}" placeholder="Basement, shelf 3">
      </div>
      <div class="field">
        <label class="field-label">Contents</label>
        <ul class="items" id="items">${(box.items ?? []).map(itemRow).join('')}</ul>
        <button class="btn" type="button" id="add-item" style="margin-top:8px">Add item</button>
      </div>
      <div class="field">
        <label class="field-label" for="notes">Notes</label>
        <textarea class="textarea" id="notes" placeholder="Anything else worth knowing">${esc(box.notes)}</textarea>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit" id="save">Save</button>
        <button class="btn" type="button" onclick="location.hash='#/scan'">Scan another</button>
        ${claimed ? '<button class="btn btn-danger" type="button" id="delete">Empty this box</button>' : ''}
      </div>
      <p class="notice notice-ok hidden" id="saved" style="margin-top:12px">Saved.</p>
    </form>
    ${claimed && box.updated_at ? `<p class="muted">Last changed ${new Date(box.updated_at).toLocaleString()}.</p>` : ''}`;

  const items = $('#items');
  if (!items.children.length) items.insertAdjacentHTML('beforeend', itemRow());

  $('#add-item').addEventListener('click', () => {
    items.insertAdjacentHTML('beforeend', itemRow());
    items.lastElementChild.querySelector('.item').focus();
  });
  items.addEventListener('click', (e) => {
    if (!e.target.classList.contains('item-remove')) return;
    e.target.closest('li').remove();
    if (!items.children.length) items.insertAdjacentHTML('beforeend', itemRow());
  });

  $('#box-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api(`boxes/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: {
          name: $('#name').value,
          location: $('#location').value,
          notes: $('#notes').value,
          items: [...items.querySelectorAll('.item')].map((i) => i.value.trim()).filter(Boolean),
        },
      });
      $('#saved').classList.remove('hidden');
      setTimeout(() => $('#saved')?.classList.add('hidden'), 2000);
    } catch (err) {
      if (err instanceof AuthError) return renderSignIn();
      alert(err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  });

  $('#delete')?.addEventListener('click', async () => {
    if (!confirm(`Clear everything recorded against ${id}? The label stays printed and can be reused.`)) return;
    await api(`boxes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    render();
  });
}

/* ---------- search ---------- */

function resultCard(r) {
  const items = (r.items ?? []).slice(0, 6).join(', ');
  return `<a class="card card-link" href="#/box/${encodeURIComponent(r.label_id)}">
    <div class="row"><strong>${esc(r.name) || '<span class="muted">Unnamed box</span>'}</strong>
    <span class="idtext muted" style="font-size:13px">${esc(r.label_id)}</span></div>
    ${r.location ? `<p class="muted" style="margin:4px 0 0">${esc(r.location)}</p>` : ''}
    ${items ? `<p class="muted" style="margin:4px 0 0">${esc(items)}${(r.items?.length ?? 0) > 6 ? '…' : ''}</p>` : ''}
  </a>`;
}

async function renderSearch() {
  view.innerHTML = `
    <p class="legend">Search</p>
    <input class="search" id="q" type="search" placeholder="ski boots" autocomplete="off"
           enterkeyhint="search" aria-label="Search box contents">
    <p class="muted" style="margin:8px 0 16px">Searches every item, name, location and note.</p>
    <div id="results"></div>`;

  const q = $('#q'), results = $('#results');
  let timer, seq = 0;

  const run = async () => {
    const term = q.value.trim();
    const mine = ++seq;
    if (!term) { results.innerHTML = ''; return; }
    try {
      const data = await api(`search?q=${encodeURIComponent(term)}`);
      if (mine !== seq) return;          // a later keystroke already answered
      results.innerHTML = data.results.length
        ? data.results.map(resultCard).join('')
        : `<div class="empty"><h2>Nothing found</h2><p class="muted">No box mentions “${esc(term)}”.</p></div>`;
    } catch (err) {
      if (err instanceof AuthError) return renderSignIn();
      results.innerHTML = `<p class="notice notice-warn">${esc(err.message)}</p>`;
    }
  };

  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  q.focus();
}

/* ---------- boxes ---------- */

async function renderBoxes() {
  const { boxes } = await api('boxes');
  view.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <p class="legend" style="margin:0">All boxes</p>
      <a class="linkbtn" href="#/unclaimed">Unused labels</a>
    </div>
    ${boxes.length ? boxes.map((b) => `
      <a class="card card-link" href="#/box/${encodeURIComponent(b.label_id)}">
        <div class="row"><strong>${esc(b.name) || '<span class="muted">Unnamed box</span>'}</strong>
        <span class="idtext muted" style="font-size:13px">${esc(b.label_id)}</span></div>
        <p class="muted" style="margin:4px 0 0">
          ${b.location ? esc(b.location) + ' · ' : ''}${b.item_count} item${b.item_count === 1 ? '' : 's'}
        </p>
      </a>`).join('')
    : `<div class="empty"><h2>No boxes yet</h2>
        <p class="muted">Scan a printed label and tell it what went in.</p>
        <button class="btn btn-primary" type="button" onclick="location.hash='#/scan'">Scan a label</button></div>`}`;
}

async function renderUnclaimed() {
  const { labels } = await api('labels/unclaimed');
  view.innerHTML = `
    <p class="legend">Printed, not yet used</p>
    <p class="muted" style="margin:0 0 16px">Labels Quire minted that are not on a box yet.</p>
    <div class="card">
      <p class="legend">Import a Quire manifest</p>
      <input type="file" id="manifest" accept="application/json,.json">
      <p class="muted" style="margin:8px 0 0">Loads the IDs from a printed sheet so they show up here.</p>
      <p class="notice hidden" id="import-result" style="margin-top:10px"></p>
    </div>
    ${labels.length
      ? `<div class="card">${labels.map((l) => `<div class="item-read"><a class="idtext" style="color:inherit"
           href="#/box/${encodeURIComponent(l.id)}">${esc(l.id)}</a></div>`).join('')}</div>`
      : `<p class="muted">None — every imported label is on a box.</p>`}`;

  $('#manifest').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const out = $('#import-result');
    out.classList.remove('hidden', 'notice-warn');
    out.textContent = 'Importing…';
    try {
      const manifest = JSON.parse(await file.text());
      const r = await api('labels/import', { method: 'POST', body: manifest });
      out.textContent = `Imported ${r.imported} new label${r.imported === 1 ? '' : 's'}`
        + `${r.skipped ? `, skipped ${r.skipped} that were not valid IDs` : ''}. ${r.total} known in total.`;
      setTimeout(render, 1200);
    } catch (err) {
      out.classList.add('notice-warn');
      out.textContent = err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message;
    }
  });
}

/* ---------- boot ---------- */

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => go(t.dataset.route)));

$('#signout').addEventListener('click', async () => {
  await api('session', { method: 'DELETE' }).catch(() => {});
  renderSignIn();
});

window.addEventListener('hashchange', render);
window.addEventListener('pagehide', stopCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

(async () => {
  const { authenticated } = await api('session').catch(() => ({ authenticated: false }));
  if (!authenticated) return renderSignIn();
  setChrome(true);
  render();
})();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
