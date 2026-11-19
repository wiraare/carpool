// carpool site log. paste into a google apps script project (script.google.com).
// the site posts events here (doPost), they go in a google sheet that only you own,
// and opening the web app link while signed in as you shows the dashboard (doGet).
// anyone else who opens the link just sees "Nothing here."

const SHEET = 'Log';
const COLS = ['time', 'visitor', 'session', 'event', 'device', 'browser', 'os', 'lang', 'screen', 'tz', 'referrer', 'details'];
const MAX_ROWS_SHOWN = 5000;

// the sheet gets made the first time, so there's nothing to set up by hand
function sheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('sheetId');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Carpool site log');
    props.setProperty('sheetId', ss.getId());
    const sh = ss.getSheets()[0];
    sh.setName(SHEET);
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
  }
  return ss.getSheetByName(SHEET);
}

// only the owner of the script gets past this
function isOwner_() {
  const me = Session.getEffectiveUser().getEmail();
  const you = Session.getActiveUser().getEmail();
  return !!me && me === you;
}

function doPost(e) {
  let x;
  try { x = JSON.parse(e.postData.contents); } catch (err) { return text_('bad'); }
  if (!x || typeof x.event !== 'string') return text_('bad');
  // anyone can post here, so keep everything short
  // and never let it start with = + - @, or the sheet would run it as a formula
  const safe = (s) => (/^[=+\-@]/.test(s) ? "'" + s : s);
  const clip = (v, n) => safe(String(v == null ? '' : v).slice(0, n));
  let details = '';
  try { details = safe(JSON.stringify(x.details || {}).slice(0, 500)); } catch (err) {}
  const row = [new Date(), clip(x.visitor, 16), clip(x.session, 16), clip(x.event, 30), clip(x.device, 12), clip(x.browser, 12),
    clip(x.os, 12), clip(x.lang, 12), clip(x.screen, 12), clip(x.tz, 40), clip(x.referrer, 80), details];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { sheet_().appendRow(row); } finally { lock.releaseLock(); }
  return text_('ok');
}

function doGet() {
  if (!isOwner_()) return HtmlService.createHtmlOutput('Nothing here.');
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Carpool site log')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// the dashboard calls this. newest rows last
function getLog() {
  if (!isOwner_()) throw new Error('Not allowed');
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return { rows: [], sheetUrl: sh.getParent().getUrl() };
  const start = Math.max(2, last - MAX_ROWS_SHOWN + 1);
  const rows = sh.getRange(start, 1, last - start + 1, COLS.length).getValues()
    .map((r) => { r[0] = r[0] instanceof Date ? r[0].toISOString() : String(r[0]); return r.map(String); });
  return { rows: rows, sheetUrl: sh.getParent().getUrl(), total: last - 1 };
}

// wipe the log (keeps the header row)
function clearLog() {
  if (!isOwner_()) throw new Error('Not allowed');
  const sh = sheet_();
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  return true;
}

// run this once from the editor so google asks for permission and makes the sheet
function setup() {
  Logger.log('Log sheet: ' + sheet_().getParent().getUrl());
}

function text_(s) {
  return ContentService.createTextOutput(s);
}
