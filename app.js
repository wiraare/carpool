// Carpool Planner: geocodes everyone, assigns riders to drivers by cheapest
// detour, then asks the Google Routes API for the best pickup order per car.

const COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#4b5563'];
const STORE_KEY = 'carpool-state';
const KEY_KEY = 'carpool-api-key';
const WSDOT_KEY = 'carpool-wsdot-code';

// Keys built into this copy of the app (config.js) win over ones typed in.
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
let located = null; // { lat, lng, addr } from the last "Use my location"
// ---------- free-tier guard ----------
// Google gives each API a free monthly allowance (5,000–10,000 calls). The app
// counts its own calls and refuses to go past these limits, set well under
// the free amounts, so it never runs into paid usage. Counts are kept per
// browser and reset each month (Pacific time, like Google's billing).
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

// Address lookups are kept for 30 days (the longest Google allows) so the
// same addresses aren't looked up, and counted, on every plan.
const GEO_KEY = 'carpool-geocache';
const GEO_TTL = 30 * 864e5;
const geoCache = new Map();
try {
  for (const [addr, v] of Object.entries(JSON.parse(localStorage.getItem(GEO_KEY)) || {})) {
    if (Date.now() - v.at < GEO_TTL) geoCache.set(addr, v);
  }
} catch {}

// ---------- state & sharing ----------

function encodeState(s) {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// The share link (#trip=…) is the whole trip. When private addresses are on,
// whoever starts the trip (the organizer) gets a key pair: the public half
// goes in the link, the private half stays in their browser only. Every
// address in the link is encrypted to the public half, so only the organizer
// can read them; anyone else with the link sees names only, but can still add
// themselves (their own address stays readable to them in their browser).

function loadState() {
  const m = location.hash.match(/^#trip=(.+)$/);
  let fromLink = null, saved = null;
  try { if (m) fromLink = decodeState(m[1]); } catch (e) { console.warn('Could not read the trip link', e); }
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)); } catch {}
  let loaded = fromLink || saved;
  // Same trip as the one saved here (e.g. a link someone sent back): merge, so
  // people added in different copies of the link all end up together.
  if (fromLink && saved && fromLink.tripId && fromLink.tripId === saved.tripId) loaded = mergeTrips(saved, fromLink);
  if (!loaded) return state;
  // Older links have no settings block.
  return { removed: [], ...loaded, settings: { ...DEFAULT_SETTINGS, ...loaded.settings } };
}

function mergeTrips(saved, link) {
  const removed = [...new Set([...(saved.removed || []), ...(link.removed || [])])];
  const people = new Map();
  for (const p of link.people || []) people.set(p.id, p);
  for (const p of saved.people || []) {
    const q = people.get(p.id);
    // Keep the readable address we already have here.
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

// Rewrites the address bar (= the share link), encrypting addresses first
// when they're private. Returns once the link is up to date.
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
    // Addresses this browser can't read stay encrypted.
    shared = { ...state, people: state.people.map(({ enc, encSig, ...p }) => (isLocked(p) ? { ...p, enc } : p)) };
  }
  if (mine === hashSeq) history.replaceState(null, '', '#trip=' + encodeState(shared));
}

// ---------- address privacy (Web Crypto: ECDH P-256 + AES-GCM) ----------

const TRIP_KEYS = 'carpool-tripkeys'; // tripId -> organizer's private key (JWK)
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

// A fresh throwaway key pair per address; the result is
// [its public key (65 bytes) | IV (12) | AES-GCM ciphertext].
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

// The organizer's browser unlocks every address it can.
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

// ---------- UI ----------

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
  // Only the organizer can turn privacy off; anyone else couldn't read the addresses anyway.
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
  // The access code is personal, so it stays in this browser and out of share links.
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
      // Keep the exact GPS point unless the address was edited afterwards.
      ...(located && located.addr === addr ? { coords: { lat: located.lat, lng: located.lng } } : {}),
    });
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
    // Remember the removal so merging an older link doesn't bring them back.
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
    // A new trip gets new keys (made on the next save).
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

// Ask the browser for the device's position, then turn it into a street
// address with the Geocoder (or plain coordinates if the map isn't loaded).
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

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// ---------- Google Maps ----------

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

// Address suggestions from the Places API (New). If that API isn't enabled on
// the key, suggestions quietly switch off and typed addresses still work.
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
  input.setAttribute('aria-autocomplete', 'list');

  let token = null, timer = null, items = [], active = -1, seq = 0;

  const close = () => { list.hidden = true; items = []; active = -1; };
  const choose = (text) => {
    input.value = text;
    close();
    token = null; // a pick ends the billing session
    input.dispatchEvent(new Event('change'));
  };
  const highlight = (i) => {
    active = i;
    [...list.querySelectorAll('li[data-i]')].forEach((li) => li.setAttribute('aria-selected', String(+li.dataset.i === i)));
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    // Wait for a pause in typing and at least 4 letters, to keep requests low.
    if (placesOff || text.length < 4 || !hasQuota('suggest')) { close(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        useQuota('suggest');
        const { AutocompleteSuggestion, AutocompleteSessionToken } = await google.maps.importLibrary('places');
        token ||= new AutocompleteSessionToken();
        const req = { input: text, sessionToken: token };
        if (map?.getBounds()) req.locationBias = map.getBounds();
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
        if (mine !== seq) return; // a newer keystroke won
        items = suggestions.filter((s) => s.placePrediction).slice(0, 5).map((s) => s.placePrediction.text.toString());
        if (!items.length) { close(); return; }
        list.innerHTML = items.map((t, i) => `<li role="option" data-i="${i}">${esc(t)}</li>`).join('') + '<li class="attr">Suggestions by Google</li>';
        list.hidden = false;
        active = -1;
      } catch (e) {
        placesOff = true;
        close();
        console.warn('Address suggestions are off. Enable "Places API (New)" on your key to turn them on.', e);
      }
    }, 450);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') close();
  });
  // mousedown fires before the input's blur, so the pick isn't lost.
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
  const { results } = await geocoder.geocode({ address });
  if (!results.length) throw new Error(`Couldn't find "${address}"`);
  const loc = results[0].geometry.location;
  const out = { lat: loc.lat(), lng: loc.lng(), label: results[0].formatted_address, at: Date.now() };
  geoCache.set(address, out);
  try { localStorage.setItem(GEO_KEY, JSON.stringify(Object.fromEntries(geoCache))); } catch {}
  return out;
}

// Google Maps URLs (https://developers.google.com/maps/documentation/urls):
// these open the Google Maps app on phones and need no API key.
const ll = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

function directionsUrl(origin, stops, destination) {
  const q = new URLSearchParams({ api: '1', origin: ll(origin), destination: ll(destination), travelmode: 'driving' });
  if (stops.length) q.set('waypoints', stops.map(ll).join('|'));
  return 'https://www.google.com/maps/dir/?' + q;
}

function placeUrl(p) {
  return 'https://www.google.com/maps/search/?' + new URLSearchParams({ api: '1', query: ll(p) });
}

// With live traffic on, Google times the trip for `departAt` (or now) using
// current and predicted traffic, and marks slow/jammed stretches of the line.
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
    // Browsers normally send only the site's origin to other sites; the key is
    // locked to this page's full address, so send that (it's https either way).
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

// ---------- assignment ----------

function haversine(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// How the matcher measures a leg from a to b. Straight-line km by default;
// while planning it's swapped for real drive seconds from Google (see
// driveTimeMatrix), which matters around Puget Sound where water makes
// straight lines badly wrong.
let travel = haversine;

// Regret insertion: for each rider find the cheapest detour into every car
// with a free seat. Seat first the rider who'd lose the most if their best
// car filled up, so nobody gets stranded with a long detour later.
// The Routes API reorders pickups afterwards.
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
    if (!pick) break; // no seats left
    pick.car.riders.splice(pick.i, 0, pick.rider);
    left.splice(left.indexOf(pick.rider), 1);
  }
  if (polish) improve(cars, dest);
  return { cars, unassigned: left };
}

// Build a pickup order by cheapest insertion and return it with its length.
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

// Local search: keep moving a rider to another car, or swapping two riders
// between cars, while that shortens the total driving.
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

// Total driving across all cars, with a heavy penalty for anyone left without
// a seat.
function score({ cars, unassigned }, dest) {
  let km = 0;
  for (const car of cars) {
    const path = [car.driver.pos, ...car.riders.map((r) => r.pos), dest];
    for (let i = 0; i < path.length - 1; i++) km += travel(path[i], path[i + 1]);
  }
  return km + unassigned.length * 1e6;
}

// Real drive times between every person (and from each person to the
// destination) via Google's Route Matrix, returned as a `travel` function in
// seconds. Returns { reason } instead when it can't be used. Plain drive
// times without live traffic: they only decide who rides with whom, and that
// keeps it in Google's cheapest (10,000 free a month) tier.
const matrixCache = new Map(); // "from|to" -> seconds, for this page visit only

async function driveTimeMatrix(points, dest) {
  const key = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const origins = [...new Map(points.map((p) => [key(p), p])).values()];
  const dests = [...new Map([...origins, dest].map((p) => [key(p), p])).values()];
  const missing = [];
  for (const o of origins) for (const d of dests) if (key(o) !== key(d) && !matrixCache.has(key(o) + '|' + key(d))) missing.push([o, d]);

  if (missing.length) {
    // Ask only for the rows/columns still missing, 25 × 25 per request (Google's limit).
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
          // No road between them (an island without a ferry, say): make it very costly.
          matrixCache.set(key(o) + '|' + key(d), el.condition === 'ROUTE_EXISTS' ? secs(el.duration) : 1e5);
        }
      }
    }
  }
  return {
    cost: (a, b) => {
      const ka = key(a), kb = key(b);
      if (ka === kb) return 0;
      // Anything Google didn't answer falls back to ~1 km per minute.
      return matrixCache.get(ka + '|' + kb) ?? haversine(a, b) * 60;
    },
  };
}

// People that the k roomiest cars in `cars` can carry (drivers included).
function topCapacity(cars, k) {
  return cars.map((d) => d.seats + 1).sort((a, b) => b - a).slice(0, k).reduce((s, c) => s + c, 0);
}

// Decide which drivers take their car. Work out how many cars to keep, then,
// starting with everyone driving, keep sending home the car whose removal (its
// driver becomes a rider) adds the least driving. A car is only sent home if
// the cars left can still seat as many people as the best k cars could.
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
  // Trials skip the local search for speed; the final plan gets it.
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

// ---------- WSDOT highway alerts ----------
// https://wsdot.wa.gov/traffic/api/ — their server doesn't allow normal
// cross-site requests, but it supports JSONP via a `callback` parameter.

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

// A full closure, not just a lane or shoulder ("right lane closed").
const isClosure = (a) => /clos/i.test(a.category)
  || /road (is )?closed|all lanes (are )?(closed|blocked)|closed in both directions|fully closed/i.test(a.headline);

function alertIcon(a) {
  if (isClosure(a)) return '⛔';
  const t = a.category + ' ' + a.headline;
  if (/collision|crash|incident|disabled|fire|blocking/i.test(t)) return '🚨';
  if (/construct|maint|road ?work|paving|bridge work/i.test(t)) return '🚧';
  return '⚠️';
}

// Shortest distance (km) from point p to segment a–b, on a flat projection
// around p (fine at highway scales).
function segDistKm(p, a, b) {
  const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180), ky = 110.57;
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// Alerts whose start or end point lies within `km` of the route line.
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

// ---------- planning ----------

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

    // Match on real drive times when we can, straight lines otherwise.
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

    // Arrival target: today at that time, or tomorrow if it's already passed.
    let arrive = null;
    if (state.arriveBy) {
      const [h, m] = state.arriveBy.split(':').map(Number);
      arrive = new Date();
      arrive.setHours(h, m, 0, 0);
      if (arrive < Date.now()) arrive.setDate(arrive.getDate() + 1);
    }

    // With live traffic and an arrival time, re-time each route for when the
    // driver would actually leave, so predicted rush-hour traffic counts.
    const routeFor = async (c) => {
      const stops = c.riders.map((r) => r.pos);
      const first = await computeRoute(c.driver.pos, dest, stops);
      if (!arrive || !state.settings.liveTraffic) return first;
      const depart = new Date(+arrive - secs(first.duration) * 1000);
      return depart > Date.now() + 60000 ? computeRoute(c.driver.pos, dest, stops, depart) : first;
    };
    // Check up front so a plan never stops halfway through its cars.
    const routeCalls = cars.length * (arrive && state.settings.liveTraffic ? 2 : 1);
    if (!hasQuota('routes', routeCalls)) useQuota('routes', routeCalls); // throws the "limit reached" message
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

      // Slow (orange) and jammed (red) stretches drawn over the car's line.
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

      // WSDOT alerts along this car's route.
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

      // Work out departure/pickup clock times when an arrival time is set.
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
