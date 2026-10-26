// carpool planner
// finds everyone on the map, figures out who rides with who, then has google
// plan the best pickup order for each car

const COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#4b5563'];
const STORE_KEY = 'carpool-state';
const KEY_KEY = 'carpool-api-key';
const WSDOT_KEY = 'carpool-wsdot-code';

// if there's a key in config.js use that, otherwise whatever someone typed in
const CONFIG = window.CARPOOL_CONFIG || {};
const builtInKey = (CONFIG.googleMapsKey || '').trim();
const apiKey = () => builtInKey || localStorage.getItem(KEY_KEY);
const wsdotCode = () => localStorage.getItem(WSDOT_KEY) || (CONFIG.wsdotCode || '').trim();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULT_SETTINGS = { defaultSeats: 3, carsMode: 'all', maxCars: 2, liveTraffic: true, showTraffic: false, realDriveTimes: true, privateAddresses: true };
let state = { dest: '', arriveBy: '', people: [], settings: { ...DEFAULT_SETTINGS } };
let map, geocoder, trafficLayer;
let overlays = [];
let located = null; // last spot from "use my location"
// --- keeping it free ---
// google gives every api a free amount each month (5k-10k calls). i count my
// own calls and stop way before that so nobody gets charged. it's per browser
// and resets on the 1st (pacific time, same as google)
const FREE_LIMITS = { map: 8000, geocode: 8000, routes: 800, suggest: 4000, matrix: 8000 };
const USAGE_KEY = 'carpool-usage';
const USAGE_LABELS = { map: 'map loads', geocode: 'address lookups', routes: 'routes', suggest: 'suggestions', matrix: 'drive-time pairs' };

const usageMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7);

function loadUsage() {
  let u = null;
  try { u = JSON.parse(localStorage.getItem(USAGE_KEY)); } catch {}
  if (!u || u.month !== usageMonth()) u = { month: usageMonth() };
  for (const k of Object.keys(FREE_LIMITS)) u[k] ||= 0;
  return u;
}

const hasQuota = (kind, n = 1) => loadUsage()[kind] + n <= FREE_LIMITS[kind];

function useQuota(kind, n = 1) {
  const u = loadUsage();
  if (u[kind] + n > FREE_LIMITS[kind]) {
    throw new Error(`Stopped to stay free: this month's limit of ${FREE_LIMITS[kind].toLocaleString()} ${USAGE_LABELS[kind]} is used up. It resets on the 1st.`);
  }
  u[kind] += n;
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {}
  renderUsage();
}

function renderUsage() {
  const u = loadUsage();
  $('usage').textContent = 'Free usage this month: ' + Object.keys(FREE_LIMITS)
    .map((k) => `${USAGE_LABELS[k]} ${u[k].toLocaleString()}/${FREE_LIMITS[k].toLocaleString()}`).join(' · ');
}

// remember address lookups for 30 days (google's max) so i'm not looking up
// the same houses every time
const GEO_KEY = 'carpool-geocache';
const GEO_TTL = 30 * 864e5;
const geoCache = new Map();
try {
  for (const [addr, v] of Object.entries(JSON.parse(localStorage.getItem(GEO_KEY)) || {})) {
    if (Date.now() - v.at < GEO_TTL) geoCache.set(addr, v);
  }
} catch {}

// --- saving + share links ---

function encodeState(s) {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// the whole trip lives in the link (#trip=...).
// with private addresses on, whoever starts the trip gets a key pair. the
// public half goes in the link and the private half never leaves their
// browser. addresses get locked with the public half so only the organizer
// can read them. everyone else just sees names, but they can still add
// themselves (and they can still see their own address)

function loadState() {
  const m = location.hash.match(/^#trip=(.+)$/);
  let fromLink = null, saved = null;
  try { if (m) fromLink = decodeState(m[1]); } catch (e) { console.warn('Could not read the trip link', e); }
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)); } catch {}
  let loaded = fromLink || saved;
  // if it's the same trip i already have (like someone sent their link back),
  // merge them so nobody gets lost between copies
  if (fromLink && saved && fromLink.tripId && fromLink.tripId === saved.tripId) loaded = mergeTrips(saved, fromLink);
  if (!loaded) return state;
  // old links don't have settings
  return { removed: [], ...loaded, settings: { ...DEFAULT_SETTINGS, ...loaded.settings } };
}

function mergeTrips(saved, link) {
  const removed = [...new Set([...(saved.removed || []), ...(link.removed || [])])];
  const people = new Map();
  for (const p of link.people || []) people.set(p.id, p);
  for (const p of saved.people || []) {
    const q = people.get(p.id);
    // keep the address i can already read
    if (q) people.set(p.id, { ...q, ...(p.addr ? { addr: p.addr, coords: p.coords } : {}) });
    else people.set(p.id, p);
  }
  return { ...link, removed, people: [...people.values()].filter((p) => !removed.includes(p.id)) };
}

let hashSeq = 0;

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  return updateHash();
}

// updates the link in the address bar. locks the addresses first if
// they're private
async function updateHash() {
  const mine = ++hashSeq;
  let shared = state;
  if (state.settings.privateAddresses) {
    if (!state.pub) await startPrivateTrip();
    const people = [];
    for (const p of state.people) {
      const { addr, coords, encSig, ...rest } = p;
      const sig = addr ? JSON.stringify([addr, coords || null]) : null;
      if (sig && p.encSig !== sig) { p.enc = await encryptAddress(state.pub, { addr, coords }); p.encSig = sig; }
      people.push({ ...rest, enc: p.enc });
    }
    shared = { ...state, people };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  } else {
    // if i can't read it, leave it locked
    shared = { ...state, people: state.people.map(({ enc, encSig, ...p }) => (isLocked(p) ? { ...p, enc } : p)) };
  }
  if (mine === hashSeq) history.replaceState(null, '', '#trip=' + encodeState(shared));
}

// --- private addresses (web crypto, ECDH P-256 + AES-GCM) ---

const TRIP_KEYS = 'carpool-tripkeys'; // trip id -> organizer's private key
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const bytesToB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function tripKeys() {
  try { return JSON.parse(localStorage.getItem(TRIP_KEYS)) || {}; } catch { return {}; }
}
const isOrganizer = () => !!(state.tripId && tripKeys()[state.tripId]);
const isLocked = (p) => !p.addr && !p.coords;

async function startPrivateTrip() {
  const pair = await crypto.subtle.generateKey(EC, true, ['deriveKey']);
  state.tripId = crypto.randomUUID();
  state.pub = bytesToB64(await crypto.subtle.exportKey('raw', pair.publicKey));
  const keys = tripKeys();
  keys[state.tripId] = await crypto.subtle.exportKey('jwk', pair.privateKey);
  localStorage.setItem(TRIP_KEYS, JSON.stringify(keys));
}

// new throwaway key for every address. what comes out is
// [its public key (65 bytes) | iv (12) | the locked address]
async function encryptAddress(pubB64, value) {
  const eph = await crypto.subtle.generateKey(EC, true, ['deriveKey']);
  const pub = await crypto.subtle.importKey('raw', b64ToBytes(pubB64), EC, false, []);
  const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, eph.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(value)));
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  return bytesToB64(new Uint8Array([...ephRaw, ...iv, ...new Uint8Array(ct)]));
}

async function decryptAddress(jwk, enc) {
  const b = b64ToBytes(enc);
  const priv = await crypto.subtle.importKey('jwk', jwk, EC, false, ['deriveKey']);
  const eph = await crypto.subtle.importKey('raw', b.slice(0, 65), EC, false, []);
  const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: eph }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(65, 77) }, aes, b.slice(77));
  return JSON.parse(new TextDecoder().decode(pt));
}

// organizer's browser unlocks whatever it can
async function unlockAddresses() {
  const jwk = tripKeys()[state.tripId];
  if (!jwk) return;
  for (const p of state.people) {
    if (!isLocked(p) || !p.enc) continue;
    try {
      const { addr, coords } = await decryptAddress(jwk, p.enc);
      Object.assign(p, { addr, ...(coords ? { coords } : {}), encSig: JSON.stringify([addr, coords || null]) });
    } catch (e) {
      console.warn(`Couldn't unlock ${p.name}'s address`, e);
    }
  }
}

// --- the page ---

function renderPeople() {
  const ul = $('people');
  ul.innerHTML = state.people.map((p) => `
    <li>
      <div class="who">
        <b>${esc(p.name)}</b>
        <span class="tag ${p.role}">${p.role === 'driver' ? 'Driver' : 'Rider'}</span>
        ${isLocked(p)
          ? '<div class="addr">🔒 Address private</div>'
          : `<div class="addr" title="${esc(p.addr)}">${p.coords ? '📍 ' : ''}${esc(p.addr)}</div>`}
      </div>
      ${p.role === 'driver' ? `<input class="seats" type="number" min="1" max="8" value="${p.seats}" data-seats="${p.id}" title="Free seats in ${esc(p.name)}'s car">` : ''}
      <button data-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>
    </li>`).join('') || '<li class="hint">No one added yet.</li>';
  renderPrivacy();
}

function renderPrivacy() {
  const on = state.settings.privateAddresses;
  const guest = on && state.pub && !isOrganizer();
  $('private').checked = on;
  // only the organizer can turn this off (nobody else can read them anyway)
  $('private').disabled = !!guest;
  $('privacy-note').textContent = !on
    ? 'Share links include everyone\'s home address.'
    : guest
      ? 'Addresses are private: only the person who started this trip can see them and plan. Add yourself, then use "Copy share link" and send it back to them.'
      : 'Share links hide home addresses from everyone but you. The key that unlocks them is saved only in this browser, so plan the trip here.';
}

function bindUI() {
  renderUsage();
  $('dest').value = state.dest;
  $('arrive-by').value = state.arriveBy || '';
  renderPeople();

  const s = state.settings;
  $('default-seats').value = s.defaultSeats;
  $('p-seats').value = s.defaultSeats;
  $('cars-mode').value = s.carsMode;
  $('max-cars').value = s.maxCars;
  $('max-cars-wrap').hidden = s.carsMode !== 'max';

  $('default-seats').addEventListener('change', (e) => {
    s.defaultSeats = clampInt(e.target.value, 1, 8, 3);
    e.target.value = s.defaultSeats;
    $('p-seats').value = s.defaultSeats;
    saveState();
  });
  $('cars-mode').addEventListener('change', (e) => {
    s.carsMode = e.target.value;
    $('max-cars-wrap').hidden = s.carsMode !== 'max';
    saveState();
  });
  $('max-cars').addEventListener('change', (e) => {
    s.maxCars = clampInt(e.target.value, 1, 99, 1);
    e.target.value = s.maxCars;
    saveState();
  });

  $('real-times').checked = s.realDriveTimes;
  $('real-times').addEventListener('change', (e) => { s.realDriveTimes = e.target.checked; saveState(); });

  $('live-traffic').checked = s.liveTraffic;
  $('show-traffic').checked = s.showTraffic;
  $('wsdot-code').value = localStorage.getItem(WSDOT_KEY) || '';
  if (CONFIG.wsdotCode) $('wsdot-code').placeholder = 'Built into this app';
  $('live-traffic').addEventListener('change', (e) => { s.liveTraffic = e.target.checked; saveState(); });
  $('show-traffic').addEventListener('change', (e) => { s.showTraffic = e.target.checked; saveState(); syncTrafficLayer(); });
  // wsdot code is personal so it stays here, never in links
  $('wsdot-code').addEventListener('change', (e) => {
    const code = e.target.value.trim();
    if (code) localStorage.setItem(WSDOT_KEY, code); else localStorage.removeItem(WSDOT_KEY);
    wsdotCache = null;
  });

  $('people').addEventListener('change', (e) => {
    const id = e.target.dataset?.seats;
    const p = id && state.people.find((x) => x.id === id);
    if (!p) return;
    p.seats = clampInt(e.target.value, 1, 8, p.seats);
    e.target.value = p.seats;
    saveState();
  });

  $('dest').addEventListener('change', (e) => { state.dest = e.target.value.trim(); saveState(); });
  $('arrive-by').addEventListener('change', (e) => { state.arriveBy = e.target.value; saveState(); });

  $('p-role').addEventListener('change', (e) => { $('p-seats').hidden = e.target.value !== 'driver'; });

  $('person-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const role = $('p-role').value;
    const addr = $('p-addr').value.trim();
    state.people.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: $('p-name').value.trim(),
      addr,
      role,
      seats: role === 'driver' ? Math.max(1, parseInt($('p-seats').value, 10) || 1) : 0,
      // keep the exact gps spot unless they changed the address after
      ...(located && located.addr === addr ? { coords: { lat: located.lat, lng: located.lng } } : {}),
    });
    rememberPerson(state.people[state.people.length - 1]);
    located = null;
    $('locate-status').hidden = true;
    $('p-name').value = '';
    $('p-addr').value = '';
    $('p-seats').value = state.settings.defaultSeats;
    saveState();
    renderPeople();
    $('p-name').focus();
  });

  $('people').addEventListener('click', (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    state.people = state.people.filter((p) => p.id !== id);
    // remember who got removed so an old link doesn't add them back
    state.removed = [...(state.removed || []), id];
    saveState();
    renderPeople();
  });

  $('private').addEventListener('change', (e) => { state.settings.privateAddresses = e.target.checked; saveState().then(renderPrivacy); });

  $('share').addEventListener('click', async () => {
    await saveState();
    try {
      await navigator.clipboard.writeText(location.href);
      flash($('share'), 'Copied!');
    } catch {
      prompt('Copy this link:', location.href);
    }
  });

  $('clear').addEventListener('click', () => {
    if (!confirm('Remove the destination and everyone on the list?')) return;
    // new trip = new keys (made on the next save)
    state = { dest: '', arriveBy: '', people: [], removed: [], settings: state.settings };
    $('dest').value = '';
    $('arrive-by').value = '';
    $('results').innerHTML = '';
    clearOverlays();
    saveState();
    renderPeople();
  });

  $('plan').addEventListener('click', plan);
  $('results').addEventListener('click', async (e) => {
    const url = e.target.dataset?.copy;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      flash(e.target, 'Copied!');
    } catch {
      prompt('Copy this link:', url);
    }
  });
  $('locate').addEventListener('click', useMyLocation);
  bindSavedPeople();

  if (builtInKey) {
    $('key-row').hidden = true;
    $('key-section').querySelector('.hint').textContent = 'This app has a built-in key, so there\'s nothing to set up.';
    loadMaps(builtInKey);
    return;
  }
  const key = localStorage.getItem(KEY_KEY);
  if (key) { $('api-key').value = key; loadMaps(key); }
  $('save-key').addEventListener('click', () => {
    const k = $('api-key').value.trim();
    if (!k) return;
    localStorage.setItem(KEY_KEY, k);
    if (window.google?.maps) location.reload(); else loadMaps(k);
  });
}

// get the device's location and turn it into an address
// (just coordinates if the map isn't loaded yet)
function useMyLocation() {
  const status = $('locate-status');
  const say = (html) => { status.hidden = false; status.innerHTML = html; };
  if (!navigator.geolocation) { say('<span class="error">This browser can\'t share its location.</span>'); return; }
  say('Finding you…');
  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    const lat = coords.latitude, lng = coords.longitude;
    let addr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (geocoder && hasQuota('geocode')) {
      try {
        useQuota('geocode');
        const { results } = await geocoder.geocode({ location: { lat, lng } });
        if (results.length) addr = results[0].formatted_address;
      } catch (e) {
        console.warn('Reverse geocode failed', e);
      }
    }
    located = { lat, lng, addr };
    $('p-addr').value = addr;
    say(`Found you (accurate to about ${Math.round(coords.accuracy)} m).${geocoder ? '' : ' Load the map to see a street address.'}`);
    if (map) {
      map.setCenter({ lat, lng });
      map.setZoom(15);
    }
  }, (err) => {
    const why = err.code === err.PERMISSION_DENIED ? 'Location permission was denied — allow it in your browser, or type your address.'
      : err.code === err.TIMEOUT ? 'Timed out finding your location. Try again.'
      : 'Couldn\'t get your location.';
    say(`<span class="error">${why}</span>`);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

// --- saved people ---
// a little address book so you can type someone's name and get their address.
// it only lives in this browser (never in links or on the site), so nobody
// else visiting the site can look anyone up

const CONTACTS_KEY = 'carpool-contacts';
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function loadContacts() {
  try { return JSON.parse(localStorage.getItem(CONTACTS_KEY)) || []; } catch { return []; }
}

function saveContacts(list) {
  list.sort((a, b) => a.name.localeCompare(b.name));
  try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(list)); } catch {}
  renderSavedPeople();
}

// add or update someone (matched by name, not caring about caps)
function rememberPerson(p) {
  if (!p.name || !p.addr) return;
  const list = loadContacts();
  const c = { name: p.name.trim(), addr: p.addr.trim(), ...(p.coords ? { coords: p.coords } : {}), ...(p.role === 'driver' ? { seats: p.seats } : {}) };
  const i = list.findIndex((x) => sameName(x.name, c.name));
  if (i >= 0) list[i] = { ...list[i], ...c }; else list.push(c);
  saveContacts(list);
}

// turns "12. Ko Aaron & Ci Gab → 2125 127th Pl SW, Everett" into two people.
// handles → -> => : as the split, and skips lines like "Aldo → 5 people"
function parsePeopleList(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/^\s*\d+\s*[.)]\s*/, '').trim();
    const m = line.match(/^(.+?)\s*(?:→|->|=>|:)\s*(.+)$/);
    if (!m) continue;
    const addr = m[2].trim();
    if (/^\d+\s*(people|seats?)\b/i.test(addr)) continue;
    for (const name of m[1].split(/\s*(?:&|\/|,|\band\b)\s*/i)) if (name.trim()) out.push({ name: name.trim(), addr });
  }
  return out;
}

function renderSavedPeople() {
  const list = loadContacts();
  $('saved-count').textContent = list.length;
  $('saved-list').innerHTML = list.map((c, i) => `
    <li>
      <div class="who"><b>${esc(c.name)}</b>${c.seats ? ' <span class="tag">Driver</span>' : ''}<div class="addr" title="${esc(c.addr)}">${esc(c.addr)}</div></div>
      <button type="button" data-forget="${i}" aria-label="Forget ${esc(c.name)}">✕</button>
    </li>`).join('') || '<li class="hint">Nobody saved yet. Add people above or paste a list.</li>';
}

function bindSavedPeople() {
  renderSavedPeople();

  $('import-btn').addEventListener('click', () => {
    const found = parsePeopleList($('import-text').value);
    const status = $('import-status');
    status.hidden = false;
    if (!found.length) { status.textContent = 'Couldn\'t find anyone. Put one person per line, like "Name → address".'; return; }
    const list = loadContacts();
    for (const p of found) {
      const i = list.findIndex((x) => sameName(x.name, p.name));
      if (i >= 0) list[i] = { ...list[i], addr: p.addr, coords: undefined }; else list.push(p);
    }
    saveContacts(list);
    let added = 0;
    if ($('import-trip').checked) {
      for (const p of found) {
        if (state.people.some((x) => sameName(x.name, p.name))) continue;
        state.people.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: p.name, addr: p.addr, role: 'rider', seats: 0 });
        added++;
      }
      saveState();
      renderPeople();
    }
    status.textContent = `Saved ${found.length} ${found.length === 1 ? 'person' : 'people'}${added ? `, added ${added} to this trip` : ''}.`;
    $('import-text').value = '';
  });

  $('saved-list').addEventListener('click', (e) => {
    const i = e.target.dataset?.forget;
    if (i === undefined) return;
    const list = loadContacts();
    list.splice(+i, 1);
    saveContacts(list);
  });

  $('forget-all').addEventListener('click', () => {
    if (!confirm('Forget everyone saved in this browser? (The current trip stays.)')) return;
    saveContacts([]);
  });

  attachNameLookup($('p-name'));
}

// typing in the name box shows saved people, picking one fills in the address
function attachNameLookup(input) {
  const wrap = document.createElement('div');
  wrap.className = 'ac-wrap';
  input.replaceWith(wrap);
  wrap.appendChild(input);
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.appendChild(list);
  input.setAttribute('aria-autocomplete', 'list');

  let items = [], active = -1;
  const close = () => { list.hidden = true; items = []; active = -1; };
  const highlight = (i) => {
    active = i;
    [...list.querySelectorAll('li[data-i]')].forEach((li) => li.setAttribute('aria-selected', String(+li.dataset.i === i)));
  };
  const choose = (c) => {
    input.value = c.name;
    $('p-addr').value = c.addr;
    // keep their exact gps spot if we saved one
    located = c.coords ? { ...c.coords, addr: c.addr } : null;
    if (c.seats) {
      $('p-role').value = 'driver';
      $('p-seats').value = c.seats;
      $('p-seats').hidden = false;
    }
    close();
    input.form.querySelector('button[type=submit]').focus();
  };

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    // names starting with what you typed come first, then ones that just contain it
    const all = loadContacts();
    items = [...all.filter((c) => c.name.toLowerCase().startsWith(q)), ...all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q))].slice(0, 6);
    if (!items.length) { close(); return; }
    list.innerHTML = items.map((c, i) => `<li role="option" data-i="${i}"><b>${esc(c.name)}</b><div class="who-addr">${esc(c.addr)}</div></li>`).join('');
    list.hidden = false;
    highlight(items.length === 1 ? 0 : -1);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + items.length) % items.length); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    e.preventDefault();
    if (li) choose(items[+li.dataset.i]);
  });
  input.addEventListener('blur', close);
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// --- google maps ---

function loadMaps(key) {
  try {
    useQuota('map');
  } catch (e) {
    $('key-status').innerHTML = `<span class="error">${esc(e.message)}</span>`;
    return;
  }
  $('key-status').textContent = 'Loading map…';
  window.gm_authFailure = () => {
    $('key-status').innerHTML = '<span class="error">Google rejected this key. Check it and the enabled APIs.</span>';
  };
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry,marker&v=weekly&loading=async&callback=onMapsReady`;
  s.async = true;
  s.onerror = () => { $('key-status').innerHTML = '<span class="error">Could not load Google Maps.</span>'; };
  document.head.appendChild(s);
}

window.onMapsReady = () => {
  map = new google.maps.Map($('map'), {
    center: { lat: 39.5, lng: -98.35 },
    zoom: 4,
    mapId: 'DEMO_MAP_ID',
    streetViewControl: false,
  });
  geocoder = new google.maps.Geocoder();
  $('key-status').textContent = 'Map loaded.';
  attachAutocomplete($('dest'));
  attachAutocomplete($('p-addr'));
  syncTrafficLayer();
};

function syncTrafficLayer() {
  if (!map) return;
  trafficLayer ||= new google.maps.TrafficLayer();
  trafficLayer.setMap(state.settings.showTraffic ? map : null);
}

// address suggestions while typing (places api new). if the key doesn't have
// it, suggestions just turn off and typing still works
let placesOff = false;

function attachAutocomplete(input) {
  const wrap = document.createElement('div');
  wrap.className = 'ac-wrap';
  input.replaceWith(wrap);
  wrap.appendChild(input);
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.appendChild(list);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-autocomplete', 'both');

  // the grey "rest of the address" that shows up after what you typed.
  // it sits behind the input (which is see-through) and lines up with the text
  const ghost = document.createElement('div');
  ghost.className = 'ac-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.innerHTML = '<span class="typed"></span><span class="rest"></span>';
  wrap.prepend(ghost);

  let token = null, timer = null, items = [], active = -1, seq = 0;
  let pool = []; // what google gave us last time, reused while it still fits
  let guess = ''; // the full address the grey text is predicting

  const lower = (s) => s.toLowerCase();
  const hideGhost = () => { guess = ''; ghost.querySelector('.typed').textContent = ''; ghost.querySelector('.rest').textContent = ''; };
  const close = () => { list.hidden = true; items = []; active = -1; hideGhost(); };
  const choose = (text) => {
    input.value = text;
    close();
    pool = [];
    token = null; // picking one ends the session (how google bills it)
    input.dispatchEvent(new Event('change'));
  };
  const highlight = (i) => {
    active = i;
    [...list.querySelectorAll('li[data-i]')].forEach((li) => li.setAttribute('aria-selected', String(+li.dataset.i === i)));
  };

  // show the dropdown + grey prediction for whatever's typed right now
  const show = (matches) => {
    const typed = input.value;
    items = matches.slice(0, 5);
    if (!items.length) { close(); return; }
    list.innerHTML = items.map((t, i) => `<li role="option" data-i="${i}">${esc(t)}</li>`).join('') + '<li class="attr">Suggestions by Google</li>';
    list.hidden = false;
    active = -1;
    // only predict when the top pick starts with exactly what they typed,
    // the cursor is at the end, and the text isn't scrolled sideways
    const top = items.find((t) => lower(t).startsWith(lower(typed)) && t.length > typed.length);
    const atEnd = input.selectionStart === typed.length && input.selectionEnd === typed.length;
    if (top && atEnd && document.activeElement === input && input.scrollWidth <= input.clientWidth) {
      guess = top;
      ghost.querySelector('.typed').textContent = typed;
      ghost.querySelector('.rest').textContent = top.slice(typed.length);
    } else {
      hideGhost();
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (placesOff || text.length < 3) { close(); return; }
    // still typing into something we already have? just filter it, no new request
    const stillFits = pool.filter((t) => lower(t).includes(lower(text)));
    if (stillFits.some((t) => lower(t).startsWith(lower(input.value)))) { show(stillFits); return; }
    show(stillFits);
    if (!hasQuota('suggest')) return;
    // short pause so it doesn't send a request every single letter
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        useQuota('suggest');
        const { AutocompleteSuggestion, AutocompleteSessionToken } = await google.maps.importLibrary('places');
        token ||= new AutocompleteSessionToken();
        const req = { input: text, sessionToken: token };
        if (map?.getBounds()) req.locationBias = map.getBounds();
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
        if (mine !== seq) return; // they kept typing, skip this one
        pool = suggestions.filter((s) => s.placePrediction).map((s) => s.placePrediction.text.toString());
        if (input.value.trim() === text) show(pool);
      } catch (e) {
        placesOff = true;
        close();
        console.warn('Address suggestions are off. Enable "Places API (New)" on your key to turn them on.', e);
      }
    }, 300);
  });

  input.addEventListener('keydown', (e) => {
    // tab or right arrow takes the grey prediction
    const atEnd = input.selectionStart === input.value.length;
    if (guess && (e.key === 'Tab' || (e.key === 'ArrowRight' && atEnd)) && !e.shiftKey) {
      e.preventDefault();
      choose(guess);
      return;
    }
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') close();
  });
  // moving the cursor around (clicking, home/end) can make the prediction not fit anymore
  input.addEventListener('keyup', (e) => { if (/Arrow|Home|End/.test(e.key) && items.length) show(items); });
  input.addEventListener('click', () => { if (items.length) show(items); });
  // mousedown happens before blur, otherwise the click gets lost
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    e.preventDefault();
    if (li) choose(items[+li.dataset.i]);
  });
  input.addEventListener('blur', close);
}

async function geocode(address) {
  if (geoCache.has(address)) return geoCache.get(address);
  useQuota('geocode');
  // stay in the US, otherwise "17824 33rd Pl W, WA" ends up in poland
  const { results } = await geocoder.geocode({ address, componentRestrictions: { country: 'US' } });
  if (!results.length) throw new Error(`Couldn't find "${address}"`);
  // a whole state or county isn't a pickup spot, google does that when the city is missing
  if (results[0].types.some((t) => ['country', 'administrative_area_level_1', 'administrative_area_level_2'].includes(t))) {
    throw new Error(`Couldn't find "${address}" exactly (Google only got as far as ${results[0].formatted_address}). Add the city, like "Lynnwood, WA"`);
  }
  const loc = results[0].geometry.location;
  const out = { lat: loc.lat(), lng: loc.lng(), label: results[0].formatted_address, at: Date.now() };
  geoCache.set(address, out);
  try { localStorage.setItem(GEO_KEY, JSON.stringify(Object.fromEntries(geoCache))); } catch {}
  return out;
}

// normal google maps links (no key needed), they open the app on phones
// https://developers.google.com/maps/documentation/urls
const ll = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

function directionsUrl(origin, stops, destination) {
  const q = new URLSearchParams({ api: '1', origin: ll(origin), destination: ll(destination), travelmode: 'driving' });
  if (stops.length) q.set('waypoints', stops.map(ll).join('|'));
  return 'https://www.google.com/maps/dir/?' + q;
}

function placeUrl(p) {
  return 'https://www.google.com/maps/search/?' + new URLSearchParams({ api: '1', query: ll(p) });
}

// with live traffic on, google times it for when you'd leave (or now) and
// marks the slow / jammed parts
async function computeRoute(origin, destination, stops, departAt = null) {
  const pt = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const live = state.settings.liveTraffic;
  const body = {
    origin: pt(origin),
    destination: pt(destination),
    intermediates: stops.map(pt),
    travelMode: 'DRIVE',
    optimizeWaypointOrder: stops.length > 1,
    routingPreference: live ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
  };
  if (live) {
    body.extraComputations = ['TRAFFIC_ON_POLYLINE'];
    if (departAt && departAt > Date.now() + 60000) body.departureTime = departAt.toISOString();
  }
  useQuota('routes');
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    // browsers only send the site name by default but my key is locked to the
    // full /carpool/ address, so send the whole thing
    referrerPolicy: 'no-referrer-when-downgrade',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey(),
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.optimizedIntermediateWaypointIndex,routes.legs.duration,routes.legs.distanceMeters,routes.travelAdvisory.speedReadingIntervals',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || `Routes API error ${res.status}`;
    if (res.status === 403) throw new Error(`Google refused the route request (${msg}). Check that Routes API is turned on for this key and that the key allows this website`);
    throw new Error(msg);
  }
  if (!data.routes?.length) throw new Error('No driving route found');
  return data.routes[0];
}

function clearOverlays() {
  overlays.forEach((o) => (o.setMap ? o.setMap(null) : (o.map = null)));
  overlays = [];
}

function addMarker(pos, color, glyph, title) {
  const { AdvancedMarkerElement, PinElement } = google.maps.marker;
  const pin = new PinElement({ background: color, borderColor: '#fff', glyphColor: '#fff', glyphText: glyph });
  const m = new AdvancedMarkerElement({ map, position: pos, content: pin, title });
  overlays.push(m);
}

// --- who rides with who ---

function haversine(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// how far it is from a to b. straight line by default, but when planning it
// gets swapped for real drive times from google (driveTimeMatrix). this
// matters a lot around the sound, bremerton looks close to seattle but it
// really isn't
let travel = haversine;

// for every rider, find the smallest detour into each car that has room.
// whoever would lose the most if their best car filled up gets seated first,
// so nobody's stuck with a huge detour at the end. google fixes the pickup
// order later
function assign(drivers, riders, dest, polish = true) {
  const cars = drivers.map((d) => ({ driver: d, riders: [] }));
  const left = [...riders];
  while (left.length) {
    let pick = null;
    for (const rider of left) {
      const options = [];
      for (const car of cars) {
        if (car.riders.length >= car.driver.seats) continue;
        const path = [car.driver.pos, ...car.riders.map((r) => r.pos), dest];
        let best = null;
        for (let i = 0; i < path.length - 1; i++) {
          const cost = travel(path[i], rider.pos) + travel(rider.pos, path[i + 1]) - travel(path[i], path[i + 1]);
          if (!best || cost < best.cost) best = { cost, car, i };
        }
        options.push(best);
      }
      if (!options.length) continue;
      options.sort((a, b) => a.cost - b.cost);
      const regret = options.length > 1 ? options[1].cost - options[0].cost : Infinity;
      if (!pick || regret > pick.regret || (regret === pick.regret && options[0].cost < pick.cost)) {
        pick = { ...options[0], rider, regret };
      }
    }
    if (!pick) break; // out of seats
    pick.car.riders.splice(pick.i, 0, pick.rider);
    left.splice(left.indexOf(pick.rider), 1);
  }
  if (polish) improve(cars, dest);
  return { cars, unassigned: left };
}

// build a pickup order one rider at a time and say how long it is
function orderRiders(driver, riders, dest) {
  const order = [];
  for (const r of riders) {
    const path = [driver.pos, ...order.map((x) => x.pos), dest];
    let bestI = 0, bestCost = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const cost = travel(path[i], r.pos) + travel(r.pos, path[i + 1]) - travel(path[i], path[i + 1]);
      if (cost < bestCost) { bestCost = cost; bestI = i; }
    }
    order.splice(bestI, 0, r);
  }
  const path = [driver.pos, ...order.map((x) => x.pos), dest];
  let km = 0;
  for (let i = 0; i < path.length - 1; i++) km += travel(path[i], path[i + 1]);
  return { order, km };
}

// keep trying to move a rider to another car or swap two riders, as long
// as it cuts the total driving
function improve(cars, dest) {
  const len = (car, riders) => orderRiders(car.driver, riders, dest).km;
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (const a of cars) {
      for (const b of cars) {
        if (a === b) continue;
        for (const r of [...a.riders]) {
          const aWithout = a.riders.filter((x) => x !== r);
          const before = len(a, a.riders) + len(b, b.riders);
          if (b.riders.length < b.driver.seats && len(a, aWithout) + len(b, [...b.riders, r]) < before - 1e-6) {
            a.riders = orderRiders(a.driver, aWithout, dest).order;
            b.riders = orderRiders(b.driver, [...b.riders, r], dest).order;
            changed = true;
            continue;
          }
          for (const s of b.riders) {
            const bSwapped = b.riders.map((x) => (x === s ? r : x));
            const aSwapped = a.riders.map((x) => (x === r ? s : x));
            if (len(a, aSwapped) + len(b, bSwapped) < before - 1e-6) {
              a.riders = orderRiders(a.driver, aSwapped, dest).order;
              b.riders = orderRiders(b.driver, bSwapped, dest).order;
              changed = true;
              break;
            }
          }
        }
      }
    }
    if (!changed) break;
  }
}

// total driving for every car, plus a huge penalty for anyone left without a seat
function score({ cars, unassigned }, dest) {
  let km = 0;
  for (const car of cars) {
    const path = [car.driver.pos, ...car.riders.map((r) => r.pos), dest];
    for (let i = 0; i < path.length - 1; i++) km += travel(path[i], path[i + 1]);
  }
  return km + unassigned.length * 1e6;
}

// real drive times between everybody (and to the destination) from google's
// route matrix. gives back a travel function in seconds, or { reason } if it
// can't. no live traffic here, it's only for picking who rides with who and
// that keeps it on the cheap tier (10k free a month)
const matrixCache = new Map(); // "from|to" -> seconds, only while the page is open

async function driveTimeMatrix(points, dest) {
  const key = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const origins = [...new Map(points.map((p) => [key(p), p])).values()];
  const dests = [...new Map([...origins, dest].map((p) => [key(p), p])).values()];
  const missing = [];
  for (const o of origins) for (const d of dests) if (key(o) !== key(d) && !matrixCache.has(key(o) + '|' + key(d))) missing.push([o, d]);

  if (missing.length) {
    // only ask for what's missing, 25 x 25 at a time (google's limit)
    const os = [...new Map(missing.map(([o]) => [key(o), o])).values()];
    const ds = [...new Map(missing.map(([, d]) => [key(d), d])).values()];
    const pairs = os.length * ds.length;
    if (!hasQuota('matrix', pairs)) return { reason: 'this month\'s free drive-time allowance is used up' };
    const wp = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    for (let i = 0; i < os.length; i += 25) {
      for (let j = 0; j < ds.length; j += 25) {
        const oc = os.slice(i, i + 25), dc = ds.slice(j, j + 25);
        useQuota('matrix', oc.length * dc.length);
        const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
          method: 'POST',
          referrerPolicy: 'no-referrer-when-downgrade',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey(),
            'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition',
          },
          body: JSON.stringify({ origins: oc.map(wp), destinations: dc.map(wp), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || `Route Matrix error ${res.status}`);
        for (const el of data) {
          const o = oc[el.originIndex || 0], d = dc[el.destinationIndex || 0];
          // no road between them (island with no ferry or whatever), make it super expensive
          matrixCache.set(key(o) + '|' + key(d), el.condition === 'ROUTE_EXISTS' ? secs(el.duration) : 1e5);
        }
      }
    }
  }
  return {
    cost: (a, b) => {
      const ka = key(a), kb = key(b);
      if (ka === kb) return 0;
      // if google didn't answer, guess about 1 km a minute
      return matrixCache.get(ka + '|' + kb) ?? haversine(a, b) * 60;
    },
  };
}

// how many people the k biggest cars can fit (drivers count)
function topCapacity(cars, k) {
  return cars.map((d) => d.seats + 1).sort((a, b) => b - a).slice(0, k).reduce((s, c) => s + c, 0);
}

// decide which drivers actually take their car. figure out how many cars to
// keep, then start with everyone driving and keep leaving home whichever car
// adds the least driving when its driver rides instead. only leave a car home
// if the rest can still fit as many people as the best k cars could
function planCars(drivers, riders, dest, settings) {
  const total = drivers.length + riders.length;
  let target = drivers.length;
  if (settings.carsMode === 'max') {
    target = Math.min(drivers.length, Math.max(1, settings.maxCars));
  } else if (settings.carsMode === 'fewest') {
    target = 1;
    while (target < drivers.length && topCapacity(drivers, target) < total) target++;
  }
  const needed = Math.min(total, topCapacity(drivers, target));

  let active = [...drivers];
  const parked = [];
  // skip the swapping step while trying options (slow), do it once at the end
  let current = assign(active, riders, dest, false);
  while (active.length > target) {
    let best = null;
    for (const d of active) {
      const rest = active.filter((x) => x !== d);
      if (topCapacity(rest, target) < needed) continue;
      const trial = assign(rest, [...riders, ...parked, d], dest, false);
      const sc = score(trial, dest);
      if (!best || sc < best.sc) best = { d, trial, sc };
    }
    active = active.filter((x) => x !== best.d);
    parked.push(best.d);
    current = best.trial;
  }
  improve(current.cars, dest);
  return { ...current, parked };
}

// --- wsdot highway alerts ---
// https://wsdot.wa.gov/traffic/api/
// their server blocks normal requests from other sites but jsonp works

let wsdotCache = null; // { at, alerts }

function wsdotJsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = '__wsdot' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const done = () => { delete window[cb]; s.remove(); clearTimeout(t); };
    const t = setTimeout(() => { done(); reject(new Error('WSDOT took too long to answer')); }, 15000);
    window[cb] = (data) => { done(); resolve(data); };
    s.onerror = () => { done(); reject(new Error('Could not reach WSDOT')); };
    s.src = url + '&callback=' + cb;
    document.head.appendChild(s);
  });
}

const wsdotDate = (v) => { const m = /\/Date\((\d+)/.exec(v || ''); return m ? new Date(+m[1]) : null; };

async function fetchWsdotAlerts(code) {
  if (wsdotCache && Date.now() - wsdotCache.at < 5 * 60000) return wsdotCache.alerts;
  const data = await wsdotJsonp('https://wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson?AccessCode=' + encodeURIComponent(code));
  if (!Array.isArray(data)) throw new Error('WSDOT rejected the access code');
  const loc = (l) => (l && l.Latitude && l.Longitude ? { lat: l.Latitude, lng: l.Longitude } : null);
  const alerts = data.map((a) => ({
    id: a.AlertID,
    category: a.EventCategory || 'Alert',
    headline: (a.HeadlineDescription || '').trim(),
    road: [a.StartRoadwayLocation?.RoadName, a.StartRoadwayLocation?.Direction].filter(Boolean).join(' '),
    priority: a.Priority || '',
    ends: wsdotDate(a.EndTime),
    points: [loc(a.StartRoadwayLocation), loc(a.EndRoadwayLocation)].filter(Boolean),
  })).filter((a) => a.points.length);
  wsdotCache = { at: Date.now(), alerts };
  return alerts;
}

// actually closed, not just one lane ("right lane closed" doesn't count)
const isClosure = (a) => /clos/i.test(a.category)
  || /road (is )?closed|all lanes (are )?(closed|blocked)|closed in both directions|fully closed/i.test(a.headline);

function alertIcon(a) {
  if (isClosure(a)) return '⛔';
  const t = a.category + ' ' + a.headline;
  if (/collision|crash|incident|disabled|fire|blocking/i.test(t)) return '🚨';
  if (/construct|maint|road ?work|paving|bridge work/i.test(t)) return '🚧';
  return '⚠️';
}

// closest distance (km) from a point to a piece of road. treats the earth as
// flat which is fine at this size
function segDistKm(p, a, b) {
  const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180), ky = 110.57;
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// alerts that start or end close to the route
function alertsNear(path, alerts, km = 0.4) {
  if (path.length < 2) return [];
  const pad = km / 100;
  const lats = path.map((p) => p.lat), lngs = path.map((p) => p.lng);
  const box = { s: Math.min(...lats) - pad, n: Math.max(...lats) + pad, w: Math.min(...lngs) - pad, e: Math.max(...lngs) + pad };
  return alerts.filter((a) => a.points.some((p) => {
    if (p.lat < box.s || p.lat > box.n || p.lng < box.w || p.lng > box.e) return false;
    for (let i = 0; i < path.length - 1; i++) if (segDistKm(p, path[i], path[i + 1]) <= km) return true;
    return false;
  }));
}

// --- planning ---

const secs = (d) => parseInt(d, 10) || 0;
const fmtDur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const fmtDist = (m) => `${(m / 1609.34).toFixed(1)} mi`;
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function plan() {
  const out = $('results');
  if (!map) { out.innerHTML = '<div class="card error">Load the map with your API key first.</div>'; return; }
  state.dest = $('dest').value.trim();
  saveState();
  const drivers = state.people.filter((p) => p.role === 'driver');
  const riders = state.people.filter((p) => p.role === 'rider');
  if (!state.dest) { out.innerHTML = '<div class="card error">Add a destination.</div>'; return; }
  if (!drivers.length) { out.innerHTML = '<div class="card error">Add at least one driver.</div>'; return; }
  const locked = state.people.filter(isLocked);
  if (locked.length) {
    out.innerHTML = `<div class="card error">${locked.length === 1 ? '1 person\'s address is' : `${locked.length} people's addresses are`} private, so only the person who started this trip can plan it. Copy the share link and send it to them.</div>`;
    return;
  }

  out.innerHTML = '<div class="card">Planning…</div>';
  clearOverlays();

  try {
    const dest = await geocode(state.dest);
    const located = await Promise.all(state.people.map(async (p) => ({ ...p, pos: p.coords || await geocode(p.addr) })));
    const byId = Object.fromEntries(located.map((p) => [p.id, p]));

    // use real drive times if we can, straight lines if not
    let matchedBy = 'straight-line distance';
    if (state.settings.realDriveTimes) {
      try {
        const m = await driveTimeMatrix(located.map((p) => p.pos), dest);
        if (m.cost) { travel = m.cost; matchedBy = 'real drive times'; } else matchedBy += ` (${m.reason})`;
      } catch (e) {
        console.warn('Drive times unavailable, matching by straight-line distance', e);
        matchedBy += ` (Google drive times unavailable: ${e.message})`;
      }
    }
    let result;
    try {
      result = planCars(drivers.map((d) => byId[d.id]), riders.map((r) => byId[r.id]), dest, state.settings);
    } finally {
      travel = haversine;
    }
    const { cars, unassigned, parked } = result;
    const parkedIds = new Set(parked.map((d) => d.id));

    // arrive time is today, or tomorrow if it already passed
    let arrive = null;
    if (state.arriveBy) {
      const [h, m] = state.arriveBy.split(':').map(Number);
      arrive = new Date();
      arrive.setHours(h, m, 0, 0);
      if (arrive < Date.now()) arrive.setDate(arrive.getDate() + 1);
    }

    // with live traffic + an arrive time, redo each route for when the driver
    // would really leave so rush hour actually counts
    const routeFor = async (c) => {
      const stops = c.riders.map((r) => r.pos);
      const first = await computeRoute(c.driver.pos, dest, stops);
      if (!arrive || !state.settings.liveTraffic) return first;
      const depart = new Date(+arrive - secs(first.duration) * 1000);
      return depart > Date.now() + 60000 ? computeRoute(c.driver.pos, dest, stops, depart) : first;
    };
    // check first so it never runs out halfway through
    const routeCalls = cars.length * (arrive && state.settings.liveTraffic ? 2 : 1);
    if (!hasQuota('routes', routeCalls)) useQuota('routes', routeCalls); // this throws the "limit reached" message
    const code = wsdotCode();
    const [routes, wsdot] = await Promise.all([
      Promise.all(cars.map(routeFor)),
      code ? fetchWsdotAlerts(code).then((alerts) => ({ alerts }), (e) => ({ error: e.message })) : null,
    ]);

    const bounds = new google.maps.LatLngBounds(dest);
    addMarker(dest, '#111827', '★', state.dest);
    let html = `<div class="card"><b>${cars.length} car${cars.length === 1 ? '' : 's'}</b> for ${state.people.length} people${parked.length ? ` · ${parked.length} driver${parked.length === 1 ? '' : 's'} riding along instead` : ''}<div class="hint">Matched by ${esc(matchedBy)}.</div></div>`;
    if (wsdot?.error) html += `<div class="card warn">Road alerts unavailable: ${esc(wsdot.error)}.</div>`;
    const alertPins = new Set();

    cars.forEach((car, i) => {
      const color = COLORS[i % COLORS.length];
      const route = routes[i];
      const order = route.optimizedIntermediateWaypointIndex?.length ? route.optimizedIntermediateWaypointIndex.map((k) => car.riders[k]) : car.riders;
      const legs = route.legs || [];
      const total = secs(route.duration);

      const path = google.maps.geometry.encoding.decodePath(route.polyline.encodedPolyline);
      overlays.push(new google.maps.Polyline({ map, path, strokeColor: color, strokeOpacity: 0.85, strokeWeight: 5 }));
      path.forEach((p) => bounds.extend(p));
      addMarker(car.driver.pos, color, '🚗', car.driver.name);
      order.forEach((r, k) => addMarker(r.pos, color, String(k + 1), r.name));

      // slow parts in orange, jams in red
      let jamKm = 0;
      for (const iv of (state.settings.liveTraffic && route.travelAdvisory?.speedReadingIntervals) || []) {
        if (iv.speed !== 'SLOW' && iv.speed !== 'TRAFFIC_JAM') continue;
        const seg = path.slice(iv.startPolylinePointIndex || 0, (iv.endPolylinePointIndex ?? path.length - 1) + 1);
        if (iv.speed === 'TRAFFIC_JAM') jamKm += google.maps.geometry.spherical.computeLength(seg) / 1000;
        overlays.push(new google.maps.Polyline({ map, path: seg, strokeColor: iv.speed === 'TRAFFIC_JAM' ? '#dc2626' : '#f59e0b', strokeOpacity: 1, strokeWeight: 7, zIndex: 2 }));
      }
      let trafficLine = '';
      if (state.settings.liveTraffic && route.staticDuration) {
        const delay = total - secs(route.staticDuration);
        trafficLine = delay >= 60
          ? `<div class="traffic ${jamKm ? 'jam' : 'bad'}">🚦 +${fmtDur(delay)} from traffic${jamKm ? ` · ${(jamKm / 1.609).toFixed(1)} mi of jams` : ''}</div>`
          : '<div class="traffic">🚦 Traffic looks light</div>';
      }

      // wsdot alerts on this car's route
      let alertsHtml = '';
      if (wsdot?.alerts) {
        const plain = path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
        const near = alertsNear(plain, wsdot.alerts);
        near.forEach((a) => {
          if (alertPins.has(a.id)) return;
          alertPins.add(a.id);
          addMarker(a.points[0], isClosure(a) ? '#dc2626' : '#f59e0b', alertIcon(a), `${a.category}: ${a.headline}`);
        });
        alertsHtml = near.length
          ? `<div class="alerts${near.some(isClosure) ? ' closure' : ''}"><b>${near.length} road alert${near.length === 1 ? '' : 's'} on this route</b><ul>${near.map((a) => `
              <li>${alertIcon(a)} <b>${esc(a.category)}</b>${a.road ? ` · ${esc(a.road)}` : ''}<div class="hint">${esc(a.headline.length > 160 ? a.headline.slice(0, 157) + '…' : a.headline)}${a.ends ? ` · until ${esc(a.ends.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : ''}</div></li>`).join('')}</ul></div>`
          : '<div class="alerts"><p class="hint">✅ No WSDOT alerts on this route.</p></div>';
      }

      // work out leave + pickup times if there's an arrive time
      const start = arrive ? new Date(+arrive - total * 1000) : null;
      let elapsed = 0;
      const stops = order.map((r, k) => {
        elapsed += secs(legs[k]?.duration);
        const when = start ? ` · ${fmtTime(new Date(+start + elapsed * 1000))}` : ` · +${fmtDur(elapsed)}`;
        const tag = parkedIds.has(r.id) ? ' <span class="tag off">leaves car home</span>' : '';
        return `<li>Pick up <b>${esc(r.name)}</b>${tag}${when}<div class="hint"><a href="${esc(placeUrl(r.pos))}" target="_blank" rel="noopener">${esc(r.addr)}</a></div></li>`;
      }).join('');
      const nav = directionsUrl(car.driver.pos, order.map((r) => r.pos), dest);

      html += `
        <div class="card car" style="--c:${color}">
          <h3>🚗 ${esc(car.driver.name)} <span class="tag">${car.riders.length}/${car.driver.seats} seats</span></h3>
          <div class="stats">${fmtDur(total)} · ${fmtDist(route.distanceMeters || 0)}${start ? ` · leave at ${fmtTime(start)}${start.toDateString() !== new Date().toDateString() ? ' tomorrow' : ''}` : ''}</div>
          ${trafficLine}
          ${stops ? `<ol>${stops}</ol>` : '<p class="hint">No riders assigned — driving solo.</p>'}
          ${alertsHtml}
          <div class="nav-links">
            <a class="btn" href="${esc(nav)}" target="_blank" rel="noopener">Open in Google Maps</a>
            <button type="button" data-copy="${esc(nav)}">Copy route link</button>
          </div>
        </div>`;
    });

    if (unassigned.length) {
      html += `<div class="card warn"><b>Not enough seats</b> for: ${unassigned.map((r) => esc(r.name)).join(', ')}. ${state.settings.carsMode === 'max' ? 'Raise the car limit, add seats, or add a driver.' : 'Add another driver or more seats.'}</div>`;
      unassigned.forEach((r) => { addMarker(r.pos, '#dc2626', '!', r.name + ' (no ride)'); bounds.extend(r.pos); });
    }

    out.innerHTML = html;
    map.fitBounds(bounds, 40);
  } catch (err) {
    console.error(err);
    out.innerHTML = `<div class="card error">${esc(err.message || err)}</div>`;
  }
}

state = loadState();
bindUI();
unlockAddresses().then(() => { renderPeople(); saveState(); });
