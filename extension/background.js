// Background service worker (MV3, module).
// Owns chrome.storage.local for contacts/history, handles messages, and
// drives the toolbar action badge when a call is accepted.

importScripts('utils.js');
const TN = self.TN;

const STORAGE_KEYS = {
  contacts: 'contacts',
  history: 'history',
  pending: 'pendingNumber',
  settings: 'settings'
};
const HISTORY_CAP = 1000;
const DEFAULT_SETTINGS = {
  autoHealEnabled: false,
  autoHealIntervalSec: 60,
  missedScanEnabled: false,
  missedScanIntervalMin: 15,
  sidebarMode: false
};
const MISSED_ALARM = 'tn-missed-scan';
const CALLLOG_URLS = [
  'https://www.2ndnumber.tel/app/calllog.php',
  'https://2ndnumber.tel/app/calllog.php'
];
const MATCH_TOLERANCE_MS = 3 * 60 * 1000;
const RINGING_NOTIF_ID = 'tn-ringing';
let lastRingingDigits = null;
let lastRingingAt = 0;

async function showRingingNotification(number) {
  const digits = TN.normalizePhone(number);
  if (!digits) return;
  const now = Date.now();
  // De-dup: same number within 30s = same ring sequence, don't re-notify.
  if (digits === lastRingingDigits && (now - lastRingingAt) < 30000) {
    lastRingingAt = now;
    return;
  }
  lastRingingDigits = digits;
  lastRingingAt = now;
  const contact = await findContactByNumber(digits);
  const title = contact ? `Incoming call · ${contact.name}` : 'Incoming call';
  const body = contact
    ? `${TN.formatPhone(digits)}${contact.company ? ' · ' + contact.company : ''}`
    : TN.formatPhone(digits);
  try {
    await chrome.notifications.create(RINGING_NOTIF_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: body,
      priority: 2,
      requireInteraction: true
    });
  } catch (err) {
    console.warn('[2ndNumber] notification failed', err);
  }
}

async function clearRingingNotification() {
  try { await chrome.notifications.clear(RINGING_NOTIF_ID); } catch (_) { /* ignore */ }
}

const APP_URL_FILTERS = [
  'https://www.2ndnumber.tel/app/*',
  'https://2ndnumber.tel/app/*',
  'https://www.2ndnumber.tel/WebPhone/*',
  'https://2ndnumber.tel/WebPhone/*'
];

async function dialNumber(rawNumber) {
  const digits = TN.normalizePhone(rawNumber);
  if (!digits) return { ok: false, error: 'No number' };
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: APP_URL_FILTERS }); } catch (_) { /* ignore */ }
  // Prefer an /app/ tab over a /WebPhone/ iframe tab.
  tabs.sort((a, b) => {
    const ap = /\/app\//.test(a.url || '') ? 0 : 1;
    const bp = /\/app\//.test(b.url || '') ? 0 : 1;
    return ap - bp;
  });
  let tab = tabs[0];
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://www.2ndnumber.tel/app/' });
    created = true;
  } else {
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
  // Send the dial command. If the tab is freshly created, retry until the
  // content script is listening.
  const send = () => new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'tnDial', number: digits }, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch (_) { resolve(null); }
  });
  const maxAttempts = created ? 30 : 5;
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await send();
    if (resp && resp.ok) return { ok: true };
    await new Promise((r) => setTimeout(r, created ? 500 : 200));
  }
  return { ok: true, queued: true };
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...(patch || {}) };
  if (typeof next.autoHealIntervalSec !== 'number' || !isFinite(next.autoHealIntervalSec)) {
    next.autoHealIntervalSec = DEFAULT_SETTINGS.autoHealIntervalSec;
  }
  next.autoHealIntervalSec = Math.max(10, Math.min(3600, Math.round(next.autoHealIntervalSec)));
  next.autoHealEnabled = !!next.autoHealEnabled;
  if (typeof next.missedScanIntervalMin !== 'number' || !isFinite(next.missedScanIntervalMin)) {
    next.missedScanIntervalMin = DEFAULT_SETTINGS.missedScanIntervalMin;
  }
  next.missedScanIntervalMin = Math.max(1, Math.min(1440, Math.round(next.missedScanIntervalMin)));
  next.missedScanEnabled = !!next.missedScanEnabled;
  next.sidebarMode = !!next.sidebarMode;
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  await rescheduleMissedAlarm(next);
  await applySidebarMode(next.sidebarMode);
  return next;
}

async function applySidebarMode(enabled) {
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !!enabled });
    }
    // When sidebar mode is on, clearing the popup makes clicks open the side panel.
    // When off, restore the default popup.
    if (enabled) {
      await chrome.action.setPopup({ popup: '' });
    } else {
      await chrome.action.setPopup({ popup: 'popup/popup.html' });
    }
  } catch (err) {
    console.warn('[2ndNumber] applySidebarMode failed', err);
  }
}

async function rescheduleMissedAlarm(settings) {
  try { await chrome.alarms.clear(MISSED_ALARM); } catch (_) { /* ignore */ }
  const s = settings || (await getSettings());
  if (!s.missedScanEnabled) return;
  const mins = Math.max(1, Math.min(1440, s.missedScanIntervalMin || 15));
  chrome.alarms.create(MISSED_ALARM, { delayInMinutes: 0.1, periodInMinutes: mins });
}

async function getContacts() {
  const { contacts = [] } = await chrome.storage.local.get(STORAGE_KEYS.contacts);
  return contacts;
}
async function setContacts(list) {
  await chrome.storage.local.set({ [STORAGE_KEYS.contacts]: list });
}
async function getHistory() {
  const { history = [] } = await chrome.storage.local.get(STORAGE_KEYS.history);
  return history;
}
async function setHistory(list) {
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: list });
}

async function findContactByNumber(rawNumber) {
  const target = TN.normalizePhone(rawNumber);
  if (!target) return null;
  const contacts = await getContacts();
  return contacts.find((c) => TN.normalizePhone(c.phone) === target) || null;
}

async function upsertContact(draft) {
  const v = TN.validateContact(draft);
  if (!v.ok) return { ok: false, errors: v.errors };
  const contacts = await getContacts();
  const now = Date.now();
  const normalized = TN.normalizePhone(draft.phone);

  // Duplicate check by normalized phone (excluding self when editing).
  const dup = contacts.find(
    (c) => TN.normalizePhone(c.phone) === normalized && c.id !== draft.id
  );
  if (dup) {
    return { ok: false, errors: { phone: 'Another contact already uses this number' } };
  }

  if (draft.id) {
    const idx = contacts.findIndex((c) => c.id === draft.id);
    if (idx === -1) return { ok: false, errors: { _: 'Contact not found' } };
    contacts[idx] = {
      ...contacts[idx],
      ...draft,
      phone: normalized,
      phoneDisplay: TN.formatPhone(draft.phone),
      title: draft.title || '',
      updatedAt: now
    };
  } else {
    contacts.push({
      id: TN.uuid(),
      name: String(draft.name).trim(),
      phone: normalized,
      phoneDisplay: TN.formatPhone(draft.phone),
      title: draft.title || '',
      role: draft.role || '',
      company: draft.company || '',
      clientName: draft.clientName || '',
      step: draft.step || '',
      round: draft.round === '' || draft.round == null ? null : Number(draft.round),
      createdAt: now,
      updatedAt: now
    });
  }
  await setContacts(contacts);
  return { ok: true };
}

async function deleteContact(id) {
  const contacts = await getContacts();
  await setContacts(contacts.filter((c) => c.id !== id));
  return { ok: true };
}

async function recordHistory(entry) {
  const list = await getHistory();
  list.unshift({ id: TN.uuid(), timestamp: Date.now(), ...entry });
  if (list.length > HISTORY_CAP) list.length = HISTORY_CAP;
  await setHistory(list);
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: color || '#4F46E5' });
    await chrome.action.setBadgeText({ text: text || '' });
  } catch (_) {
    /* ignore */
  }
}

async function setPendingNumber(number) {
  if (number) {
    await chrome.storage.local.set({ [STORAGE_KEYS.pending]: number });
    await setBadge('NEW', '#10B981');
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.pending);
    await setBadge('', '#4F46E5');
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'lookupContact': {
          const contact = await findContactByNumber(msg.number);
          sendResponse({ ok: true, contact });
          return;
        }
        case 'getContacts': {
          sendResponse({ ok: true, contacts: await getContacts() });
          return;
        }
        case 'saveContact': {
          const res = await upsertContact(msg.draft || {});
          if (res && res.ok && msg.draft && msg.draft.phone) {
            const { pendingNumber } = await chrome.storage.local.get(STORAGE_KEYS.pending);
            if (pendingNumber && TN.normalizePhone(pendingNumber) === TN.normalizePhone(msg.draft.phone)) {
              await setPendingNumber(null);
            }
          }
          sendResponse(res);
          return;
        }
        case 'deleteContact': {
          const res = await deleteContact(msg.id);
          sendResponse(res);
          return;
        }
        case 'getHistory': {
          sendResponse({ ok: true, history: await getHistory() });
          return;
        }
        case 'clearHistory': {
          await setHistory([]);
          sendResponse({ ok: true });
          return;
        }
        case 'callAccepted': {
          await clearRingingNotification();
          lastRingingDigits = null;
          const contact = await findContactByNumber(msg.number);
          await recordHistory({
            number: msg.number,
            normalized: TN.normalizePhone(msg.number),
            action: 'accepted',
            contactId: contact ? contact.id : null,
            contactName: contact ? contact.name : null
          });
          if (contact) {
            // Known caller — clear any stale "NEW" pending number / badge so
            // the popup doesn't keep prompting to save.
            const { pendingNumber } = await chrome.storage.local.get(STORAGE_KEYS.pending);
            if (pendingNumber && TN.normalizePhone(pendingNumber) === TN.normalizePhone(msg.number)) {
              await setPendingNumber(null);
            }
          } else {
            await setPendingNumber(msg.number);
          }
          sendResponse({ ok: true, contact });
          return;
        }
        case 'callRejected': {
          await clearRingingNotification();
          lastRingingDigits = null;
          const contact = await findContactByNumber(msg.number);
          await recordHistory({
            number: msg.number,
            normalized: TN.normalizePhone(msg.number),
            action: 'rejected',
            contactId: contact ? contact.id : null,
            contactName: contact ? contact.name : null
          });
          sendResponse({ ok: true });
          return;
        }
        case 'getPending': {
          const { pendingNumber } = await chrome.storage.local.get(STORAGE_KEYS.pending);
          sendResponse({ ok: true, pendingNumber: pendingNumber || null });
          return;
        }
        case 'clearPending': {
          await setPendingNumber(null);
          sendResponse({ ok: true });
          return;
        }
        case 'getSettings': {
          const settings = await getSettings();
          sendResponse({ ok: true, settings });
          return;
        }
        case 'saveSettings': {
          const settings = await saveSettings(msg.patch || {});
          sendResponse({ ok: true, settings });
          return;
        }
        case 'scanMissedNow': {
          const res = await scanMissedCalls();
          sendResponse(res);
          return;
        }
        case 'callRinging': {
          await showRingingNotification(msg.number);
          sendResponse({ ok: true });
          return;
        }
        case 'callRingingEnded': {
          await clearRingingNotification();
          lastRingingDigits = null;
          sendResponse({ ok: true });
          return;
        }
        case 'dialNumber': {
          const res = await dialNumber(msg.number);
          sendResponse(res);
          return;
        }
        case 'importContacts': {
          // Merge; replace existing entries that share normalized phone.
          const incoming = Array.isArray(msg.contacts) ? msg.contacts : [];
          const current = await getContacts();
          const byPhone = new Map(current.map((c) => [TN.normalizePhone(c.phone), c]));
          let added = 0;
          let updated = 0;
          for (const raw of incoming) {
            const draft = {
              name: String(raw.name || '').trim(),
              phone: raw.phone,
              title: raw.title || '',
              role: raw.role || '',
              company: raw.company || '',
              clientName: raw.clientName || '',
              step: raw.step || '',
              round: raw.round || null
            };
            const v = TN.validateContact(draft);
            if (!v.ok) continue;
            const normalized = TN.normalizePhone(draft.phone);
            const now = Date.now();
            if (byPhone.has(normalized)) {
              const existing = byPhone.get(normalized);
              Object.assign(existing, draft, {
                phone: normalized,
                phoneDisplay: TN.formatPhone(draft.phone),
                updatedAt: now
              });
              updated++;
            } else {
              const next = {
                id: TN.uuid(),
                ...draft,
                phone: normalized,
                phoneDisplay: TN.formatPhone(draft.phone),
                createdAt: now,
                updatedAt: now
              };
              byPhone.set(normalized, next);
              added++;
            }
          }
          await setContacts(Array.from(byPhone.values()));
          sendResponse({ ok: true, added, updated });
          return;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[2ndNumber] background error', err);
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true; // async
});

chrome.runtime.onInstalled.addListener(async () => {
  setBadge('', '#4F46E5');
  rescheduleMissedAlarm();
  const s = await getSettings();
  applySidebarMode(s.sidebarMode);
});

chrome.runtime.onStartup.addListener(async () => {
  rescheduleMissedAlarm();
  const s = await getSettings();
  applySidebarMode(s.sidebarMode);
});

// ---------------- Missed-call scanner ----------------

function parseCallLogRows(html) {
  // Narrow to the data table tbody.
  const tbodyMatch = /id="dtBasicExample"[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html);
  const scope = tbodyMatch ? tbodyMatch[1] : html;
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(scope)) !== null) {
    const inner = m[1];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    const cellsText = [];
    let raw0 = null;
    let tm;
    while ((tm = tdRe.exec(inner)) !== null) {
      if (raw0 === null) raw0 = tm[1];
      cellsText.push(tm[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    }
    if (cellsText.length < 6) continue;
    const direction = /Inbound/i.test(raw0 || '')
      ? 'inbound'
      : (/Outbound/i.test(raw0 || '') ? 'outbound' : 'unknown');
    rows.push({
      direction,
      caller: cellsText[1],
      called: cellsText[2],
      secs: parseInt(cellsText[3], 10) || 0,
      date: cellsText[4],
      type: cellsText[5]
    });
  }
  return rows;
}

function parseLogDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  // The call log page renders timestamps in UTC+1 (not UTC+0 as the column
  // header suggests). Treat the parsed wall-clock as UTC+1 and subtract one
  // hour to get the true UTC epoch, so timeAgo() and local rendering line up
  // with the user's timezone.
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 60 * 60 * 1000;
}

async function scanMissedCalls() {
  let html;
  let lastErr = null;
  for (const url of CALLLOG_URLS) {
    try {
      const resp = await fetch(url, { credentials: 'include', cache: 'no-store' });
      if (!resp.ok) { lastErr = 'HTTP ' + resp.status; continue; }
      const body = await resp.text();
      if (/dtBasicExample/i.test(body)) { html = body; break; }
      lastErr = /name=["']?(username|password)["']?/i.test(body) ? 'Not signed in' : 'Unexpected response';
    } catch (err) {
      lastErr = String(err && err.message || err);
    }
  }
  if (!html) return { ok: false, error: lastErr || 'No call log response' };
  const rows = parseCallLogRows(html);
  console.log('[2ndNumber] scanMissed: parsed', rows.length, 'rows total');
  const inbound = rows.filter((r) => r.direction === 'inbound');
  console.log('[2ndNumber] scanMissed:', inbound.length, 'inbound rows');
  const history = await getHistory();
  const seenMissed = new Set(
    history
      .filter((h) => h.action === 'missed' && h.sourceTime && h.normalized)
      .map((h) => `${h.normalized}|${h.sourceTime}`)
  );
  let added = 0;
  let dupMissed = 0;
  let matchedAccepted = 0;
  for (const row of inbound) {
    const ts = parseLogDate(row.date);
    if (!ts) { console.log('[2ndNumber] bad date', row.date); continue; }
    const norm = TN.normalizePhone(row.caller);
    if (!norm) { console.log('[2ndNumber] bad caller', row.caller); continue; }
    const key = `${norm}|${row.date}`;
    if (seenMissed.has(key)) { dupMissed++; continue; }
    // Already recorded as accepted/rejected within tolerance window?
    const matched = history.some((h) =>
      (h.action === 'accepted' || h.action === 'rejected') &&
      h.normalized === norm &&
      typeof h.timestamp === 'number' &&
      Math.abs(h.timestamp - ts) <= MATCH_TOLERANCE_MS
    );
    if (matched) { matchedAccepted++; continue; }
    const contact = await findContactByNumber(row.caller);
    history.push({
      id: TN.uuid(),
      timestamp: ts,
      number: row.caller,
      normalized: norm,
      action: 'missed',
      source: 'calllog',
      sourceTime: row.date,
      durationSecs: row.secs,
      contactId: contact ? contact.id : null,
      contactName: contact ? contact.name : null
    });
    seenMissed.add(key);
    added++;
  }
  if (added > 0) {
    history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
    await setHistory(history);
  }
  return { ok: true, added, scanned: inbound.length, totalRows: rows.length, dupMissed, matchedAccepted };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === MISSED_ALARM) {
    scanMissedCalls().catch((err) => console.error('[2ndNumber] missed scan error', err));
  }
});

// Clicking the ringing notification focuses the 2ndnumber tab so the user can
// accept/reject from the WebPhone UI.
try {
  chrome.notifications.onClicked.addListener(async (id) => {
    if (id !== RINGING_NOTIF_ID) return;
    try { await chrome.notifications.clear(RINGING_NOTIF_ID); } catch (_) {}
    try {
      const tabs = await chrome.tabs.query({ url: APP_URL_FILTERS });
      tabs.sort((a, b) => (/\/app\//.test(a.url || '') ? 0 : 1) - (/\/app\//.test(b.url || '') ? 0 : 1));
      const tab = tabs[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (err) {
      console.warn('[2ndNumber] notification click failed', err);
    }
  });
} catch (_) { /* notifications API not available */ }
