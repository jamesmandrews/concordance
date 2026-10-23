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
};

// Moving off the box view: push whatever has not gone up yet, then stop the
// autosaver from reporting into a view it no longer owns.
function leaveBox() {
  const leaving = activeSave;
  activeSave = null;
  if (leaving) { leaving.beacon(); leaving.detach(); }
  const pill = document.getElementById('savestate');
  if (pill) { pill.textContent = ''; pill.className = 'savestate'; }
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  stopCamera();
  leaveBox();
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
  leaveBox();
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

// The camera is never opened on page load. Asking for it the moment the app
// starts means a permission prompt every single visit -- iOS Safari does not
// persist the grant per site unless the user sets it explicitly -- and most
// visits are a search, not a scan. So: open it on an explicit tap, and skip
// the tap only when the browser can tell us permission is already granted.
async function cameraAlreadyGranted() {
  try {
    const status = await navigator.permissions?.query({ name: 'camera' });
    return status?.state === 'granted';
  } catch {
    // Safari does not support querying 'camera'; treat unknown as not granted
    // so we show the button rather than triggering a surprise prompt.
    return false;
  }
}

function renderScanIdle(reason) {
  const stage = $('#stage');
  if (!stage) return;
  stage.innerHTML = `<button class="btn btn-primary scanstart" type="button" id="start-cam">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="26" height="26"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3.2"/></svg>
      ${reason ? 'Try the camera again' : 'Start camera'}
    </button>`;
  $('#scanstatus').textContent = reason || 'The camera opens only when you ask, so this page does not prompt on every visit.';
  $('#start-cam').addEventListener('click', startCamera);
}

async function startCamera() {
  const stage = $('#stage');
  const status = $('#scanstatus');
  if (!stage) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    status.innerHTML = window.isSecureContext
      ? 'This browser has no camera API. Type the ID instead.'
      : '<span style="color:var(--caution)">The camera needs HTTPS. Over plain HTTP the browser blocks it — type the ID, or reach this page over https.</span>';
    stage.innerHTML = '';
    return;
  }

  status.textContent = 'Starting camera…';
  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false,
    });
  } catch (err) {
    return renderScanIdle(err.name === 'NotAllowedError'
      ? 'Camera permission was refused. Allow it in site settings, or type the ID below.'
      : `Camera unavailable (${err.name}). Type the ID below.`);
  }

  stage.innerHTML = '<video id="cam" playsinline muted></video><div class="reticle"><div></div></div>';
  const video = $('#cam');
  video.srcObject = activeStream;
  await video.play().catch(() => {});
  status.textContent = 'Point at a label.';

  const decode = await makeDecoder();
  const started = activeStream;
  let busy = false;

  const tick = async () => {
    if (activeStream !== started) return;   // the view changed under us
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

async function renderScan() {
  view.innerHTML = `
    <p class="legend">Scan</p>
    <div class="scanstage" id="stage"></div>
    <p class="scanstatus" id="scanstatus"></p>
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

  // Already granted means starting costs no prompt, so go straight in.
  if (await cameraAlreadyGranted()) startCamera();
  else renderScanIdle();
}

/* ---------- autosave ----------
 *
 * The box form has no save button. A box gets filled in standing over it with
 * a phone in one hand, and a button is the one step in that sequence nobody
 * remembers: the keyboard covers it, the phone sleeps, the tab gets swiped
 * away, and the typing is gone.
 *
 * So every edit lands in two places. A draft in localStorage, written
 * synchronously on the keystroke, which survives a refresh, a crash or a lost
 * network. And a debounced PUT to the server. The draft is dropped only once
 * the server has acknowledged the exact payload the draft holds -- a failed
 * save therefore leaves the work recoverable rather than lost. */

const DRAFT = 'concordance.draft.';
const DEBOUNCE = 600;     // long enough to coalesce a burst of typing
const RETRY = 5000;

const draft = {
  read(id) {
    try { const v = localStorage.getItem(DRAFT + id); return v ? JSON.parse(v) : null; }
    catch { return null; }
  },
  write(id, payload) {
    try { localStorage.setItem(DRAFT + id, JSON.stringify(payload)); }
    catch { /* quota, or private mode -- the server is still being written to */ }
  },
  clear(id) {
    try { localStorage.removeItem(DRAFT + id); } catch { /* private mode */ }
  },
};

// collect() always builds its object in the same field order, so comparing
// serialisations is enough to tell "nothing actually changed".
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The autosaver for the box currently on screen, or null on every other view.
let activeSave = null;

function autosaver(id, collect, onState, known) {
  let timer = null, retry = null, running = false, dirty = false, live = true;
  let saved = known;        // the payload the server is known to hold

  // A save can still be in the air after the view is replaced; it must finish
  // (and clear its draft) without writing status into whatever is now on screen.
  const emit = (kind, extra) => { if (live) onState(kind, extra); };

  async function pump() {
    if (!live || running) return;
    running = true;
    clearTimeout(retry); retry = null;
    try {
      // Re-collect each time round: edits made while a PUT was in the air are
      // picked up here instead of queueing a second overlapping request.
      while (dirty) {
        const payload = collect();
        dirty = false;
        if (same(payload, saved)) continue;
        draft.write(id, payload);
        emit('saving');
        try {
          const data = await api(`boxes/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
          saved = payload;
          if (!dirty) draft.clear(id);          // nothing newer is relying on it
          emit('saved', data);
        } catch (err) {
          dirty = true;                         // the draft is still the truth
          if (err instanceof AuthError) { emit('auth'); return; }
          emit('error', err);
          if (live) retry = setTimeout(pump, RETRY);
          return;
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    // Called on every input event. The draft write is first and synchronous,
    // so even a tab killed between keystroke and debounce loses nothing.
    touch() {
      dirty = true;
      draft.write(id, collect());
      clearTimeout(timer);
      timer = setTimeout(pump, DEBOUNCE);
    },
    now() { clearTimeout(timer); return pump(); },
    // Unload cannot await anything, so hand the request to the browser with
    // keepalive and let it outlive the page. If it loses a race with a PUT
    // already in flight and the stale one lands last, the draft is still in
    // localStorage -- reopening the box restores it and saves it again.
    beacon() {
      clearTimeout(timer);
      const payload = collect();
      if (same(payload, saved)) return;
      draft.write(id, payload);
      try {
        fetch(`./api/boxes/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      } catch { /* the draft stands in */ }
    },
    // Navigating away within the app: let any in-flight save finish, but stop
    // touching a view that is no longer on screen.
    detach() {
      clearTimeout(timer); clearTimeout(retry);
      live = false;
    },
    forget() { this.detach(); dirty = false; draft.clear(id); },
  };
}

/* ---------- box ---------- */

function itemRow(value = '') {
  return `<li><input class="input item" value="${esc(value)}" placeholder="One thing in the box">
    <button class="btn item-remove" type="button" aria-label="Remove">&minus;</button></li>`;
}

const clockTime = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function renderBox(rawId) {
  const id = rawId.toUpperCase();
  if (!ID_RE.test(id)) {
    view.innerHTML = `<div class="empty"><h2>Not a label</h2>
      <p class="muted"><span class="idtext">${esc(id)}</span> is not a Concordance ID.</p>
      <button class="btn" type="button" onclick="location.hash='#/scan'">Back to scanning</button></div>`;
    return;
  }

  const data = await api(`boxes/${encodeURIComponent(id)}`);
  const box = data.box ?? {};
  const claimed = data.claimed;

  const server = {
    name: box.name ?? '',
    location: box.location ?? '',
    notes: box.notes ?? '',
    items: box.items ?? [],
  };

  // A draft left over from a save that never completed -- a refresh mid-edit,
  // a dead connection, a closed tab. It is newer than the server by
  // definition, so it wins. One that matches the server has done its job.
  const pending = draft.read(id);
  const restored = Boolean(pending) && !same(pending, server);
  if (pending && !restored) draft.clear(id);
  const initial = restored ? pending : server;

  view.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <span class="idtext">${esc(id)}</span>
      <span class="chip ${claimed ? '' : 'chip-warn'}" id="claim-chip">${claimed ? 'claimed' : 'empty'}</span>
    </div>
    ${claimed ? '' : `<p class="notice" id="unclaimed-note" style="margin-bottom:12px">Nothing recorded against this label yet. Fill it in and it becomes a box.</p>`}
    ${restored ? `<p class="notice notice-warn" id="restored-note" style="margin-bottom:12px">Changes from this device had not reached the server. They are back in the form below and being saved now.</p>` : ''}
    <form class="card" id="box-form">
      <div class="field">
        <label class="field-label" for="name">What is it</label>
        <input class="input" id="name" value="${esc(initial.name)}" placeholder="Winter clothes">
      </div>
      <div class="field">
        <label class="field-label" for="location">Where it lives</label>
        <input class="input" id="location" value="${esc(initial.location)}" placeholder="Basement, shelf 3">
      </div>
      <div class="field">
        <label class="field-label">Contents</label>
        <ul class="items" id="items">${initial.items.map(itemRow).join('')}</ul>
        <button class="btn" type="button" id="add-item" style="margin-top:8px">Add item</button>
      </div>
      <div class="field">
        <label class="field-label" for="notes">Notes</label>
        <textarea class="textarea" id="notes" placeholder="Anything else worth knowing">${esc(initial.notes)}</textarea>
      </div>
      <p class="notice notice-warn hidden" id="save-error" style="margin-bottom:12px"></p>
      <div class="btn-row">
        <button class="btn" type="button" onclick="location.hash='#/scan'">Scan another</button>
        <button class="btn btn-danger ${claimed ? '' : 'hidden'}" type="button" id="delete">Empty this box</button>
      </div>
      <p class="muted" style="margin:12px 0 0">Saved as you type. There is nothing to press.</p>
    </form>
    <p class="muted" id="changed-at">${claimed && box.updated_at ? `Last changed ${new Date(box.updated_at).toLocaleString()}.` : ''}</p>`;

  const items = $('#items');
  if (!items.children.length) items.insertAdjacentHTML('beforeend', itemRow());

  // Closed over the elements rather than looking them up by id, so a save
  // still in flight after the view has been replaced reads the right values.
  const nameEl = $('#name'), locEl = $('#location'), notesEl = $('#notes');
  const pill = $('#savestate'), problem = $('#save-error');

  const collect = () => ({
    name: nameEl.value,
    location: locEl.value,
    notes: notesEl.value,
    items: [...items.querySelectorAll('.item')].map((i) => i.value.trim()).filter(Boolean),
  });

  const LABELS = { saving: 'Saving', saved: 'Saved', error: 'Not saved' };

  function onState(kind, extra) {
    if (kind === 'auth') { activeSave?.detach(); return renderSignIn(); }

    pill.className = `savestate savestate-${kind}`;
    pill.textContent = kind === 'saved' ? `Saved ${clockTime()}` : LABELS[kind] ?? '';

    problem.classList.toggle('hidden', kind !== 'error');
    if (kind === 'error') {
      problem.textContent =
        `${extra?.message || 'Could not reach the server'}. Your typing is held on this device and will go up by itself once the connection is back — it is safe to close this page.`;
    }

    if (kind === 'saved') {
      const chip = $('#claim-chip');
      if (chip) { chip.textContent = 'claimed'; chip.className = 'chip'; }
      $('#unclaimed-note')?.remove();
      $('#restored-note')?.remove();
      $('#delete')?.classList.remove('hidden');
      const at = extra?.box?.updated_at;
      if (at && $('#changed-at')) $('#changed-at').textContent = `Last changed ${new Date(at).toLocaleString()}.`;
    }
  }

  const save = autosaver(id, collect, onState, server);
  activeSave = save;

  const form = $('#box-form');
  // input bubbles from every field, including item rows added later.
  form.addEventListener('input', () => save.touch());
  // Leaving a field is a natural commit point, and beats the debounce to it.
  form.addEventListener('focusout', () => save.now());
  // Enter in a text input would otherwise submit the form and reload the page.
  form.addEventListener('submit', (e) => { e.preventDefault(); save.now(); });

  $('#add-item').addEventListener('click', () => {
    items.insertAdjacentHTML('beforeend', itemRow());
    items.lastElementChild.querySelector('.item').focus();
  });

  items.addEventListener('click', (e) => {
    if (!e.target.classList.contains('item-remove')) return;
    e.target.closest('li').remove();
    if (!items.children.length) items.insertAdjacentHTML('beforeend', itemRow());
    save.touch();
  });

  $('#delete').addEventListener('click', async () => {
    if (!confirm(`Clear everything recorded against ${id}? The label stays printed and can be reused.`)) return;
    save.forget();                 // no pending edit may resurrect the box
    activeSave = null;
    await api(`boxes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    render();
  });

  if (restored) save.touch();
}

/* ---------- search ---------- */

function resultCard(r) {
  const items = (r.items ?? []).slice(0, 6).join(', ');
  return `<a class="card card-link" href="#/box/${encodeURIComponent(r.id)}">
    <div class="row"><strong>${esc(r.name) || '<span class="muted">Unnamed box</span>'}</strong>
    <span class="idtext muted" style="font-size:13px">${esc(r.id)}</span></div>
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
    <p class="legend">All boxes</p>
    ${boxes.length ? boxes.map((b) => `
      <a class="card card-link" href="#/box/${encodeURIComponent(b.id)}">
        <div class="row"><strong>${esc(b.name) || '<span class="muted">Unnamed box</span>'}</strong>
        <span class="idtext muted" style="font-size:13px">${esc(b.id)}</span></div>
        <p class="muted" style="margin:4px 0 0">
          ${b.location ? esc(b.location) + ' · ' : ''}${b.item_count} item${b.item_count === 1 ? '' : 's'}
        </p>
      </a>`).join('')
    : `<div class="empty"><h2>No boxes yet</h2>
        <p class="muted">Scan a printed label and tell it what went in.</p>
        <button class="btn btn-primary" type="button" onclick="location.hash='#/scan'">Scan a label</button></div>`}`;
}

/* ---------- boot ---------- */

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => go(t.dataset.route)));

$('#signout').addEventListener('click', async () => {
  leaveBox();                       // send a half-typed box before the session goes
  await api('session', { method: 'DELETE' }).catch(() => {});
  renderSignIn();
});

window.addEventListener('hashchange', render);

// Three ways a phone takes the page away mid-edit: a swipe, a lock, a tab
// switch. All of them get the pending edit sent with keepalive, and all of
// them have the localStorage draft behind that.
window.addEventListener('pagehide', () => { stopCamera(); activeSave?.beacon(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  stopCamera();
  activeSave?.beacon();
});
// Back from a dead tunnel or a dropped wifi: retry without waiting for a keystroke.
window.addEventListener('online', () => activeSave?.now());

(async () => {
  const { authenticated } = await api('session').catch(() => ({ authenticated: false }));
  if (!authenticated) return renderSignIn();
  setChrome(true);
  render();
})();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
