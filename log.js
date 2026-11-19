// tiny usage log so i can see how the site gets used.
// sends to the google apps script in config.js (logUrl). no names, no addresses,
// just a random id per browser, the device type and what button got used.
// open the site once with ?nolog to stop logging your own device (?log turns it back on)
(() => {
  const url = (window.CARPOOL_CONFIG?.logUrl || '').trim();
  const OFF = 'carpool-nolog';

  try {
    const q = new URLSearchParams(location.search);
    if (q.has('nolog')) localStorage.setItem(OFF, '1');
    if (q.has('log')) localStorage.removeItem(OFF);
  } catch {}

  let off = !url;
  try { off ||= localStorage.getItem(OFF) === '1'; } catch {}

  const randomId = () => (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 8);
  const keep = (store, key) => {
    try {
      let v = store.getItem(key);
      if (!v) { v = randomId(); store.setItem(key, v); }
      return v;
    } catch { return randomId(); }
  };
  const visitor = keep(localStorage, 'carpool-visitor');
  const session = keep(sessionStorage, 'carpool-session');

  const ua = navigator.userAgent;
  const device = /iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'tablet'
    : /Mobi|iPhone|Android/i.test(ua) ? 'phone' : 'computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /OPR\//.test(ua) ? 'Opera'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'other';
  const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'other';
  let referrer = '';
  try { if (document.referrer) referrer = new URL(document.referrer).hostname; } catch {}

  window.logEvent = (event, details = {}) => {
    if (off) return;
    const body = JSON.stringify({
      event, visitor, session, device, browser, os,
      lang: navigator.language || '',
      screen: `${screen.width}x${screen.height}`,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      referrer,
      details,
    });
    // text/plain so the browser doesn't need to ask google first (no cors preflight)
    try {
      if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return;
    } catch {}
    fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {});
  };

  // only whether they came from a share link, never what's in it
  logEvent('visit', { fromShareLink: location.hash.length > 1 });
})();
