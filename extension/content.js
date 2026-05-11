// Content script for https://www.2ndnumber.tel/app/* and /WebPhone/* (incl. iframes).
// The incoming-call UI is rendered inside the /WebPhone/ iframe and uses
// unknown / dynamic selectors, so we detect it heuristically: any visible
// element that looks like an Accept button (text "Accept", "Answer", phone
// glyph) plus a phone-number-shaped string nearby.
(function () {
  'use strict';

  const ATTR_ORIG = 'data-tn-original';
  const ATTR_HOOKED = 'data-tn-hooked';
  const ATTR_RENAMED = 'data-tn-renamed';
  const ATTR_NUM = 'data-tn-number';

  // Match common US/intl formats: +1 (555) 555-1234, 555-555-1234, 5555551234, etc.
  const PHONE_RE = /(\+?\d[\d\s().\-]{7,}\d)/;
  const ACCEPT_RE = /\b(accept|answer|pick\s*up|receive)\b/i;
  const REJECT_RE = /\b(reject|decline|hang\s*up|ignore|end)\b/i;

  function normalizePhone(input) {
    if (input == null) return '';
    const digits = String(input).replace(/\D+/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits;
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || { ok: false });
        });
      } catch (_) {
        resolve({ ok: false });
      }
    });
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  function extractPhoneFromText(txt) {
    if (!txt) return null;
    const m = String(txt).match(PHONE_RE);
    if (!m) return null;
    const digits = normalizePhone(m[1]);
    if (digits.length < 7) return null;
    return { raw: m[1].trim(), digits };
  }

  // Walk up the ancestor chain (deep — the page uses heavily nested tables)
  // looking for a container whose text contains a phone-number-like string.
  function findNumberNear(el) {
    let node = el;
    for (let i = 0; i < 25 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      // Prefer scanning <select><option> text content directly — the page puts
      // the caller number inside ListIncomingCall as an option label.
      const sel = node.querySelector && node.querySelector('select');
      if (sel) {
        for (const opt of sel.options || []) {
          const p = extractPhoneFromText(opt.textContent);
          if (p) return { ...p, container: node, source: opt };
        }
      }
      const p = extractPhoneFromText(node.textContent);
      if (p) return { ...p, container: node };
    }
    // Last resort: scan every visible select/option in the whole document.
    const doc = el.ownerDocument || document;
    for (const opt of doc.querySelectorAll('select option')) {
      if (!isVisible(opt.parentElement)) continue;
      const p = extractPhoneFromText(opt.textContent);
      if (p) return { ...p, container: opt.parentElement, source: opt };
    }
    return null;
  }

  // Find the text node whose content matches the raw number, so we can replace
  // ONLY that text with the contact name and keep the rest of the DOM intact.
  function findPhoneTextNode(root, raw) {
    if (!root || !raw) return null;
    const needle = raw.trim();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue;
      if (!t) continue;
      if (t.indexOf(needle) !== -1) return n;
      // Looser match: same digits ignoring formatting
      const tdigits = normalizePhone(t);
      const ndigits = normalizePhone(needle);
      if (ndigits && tdigits && tdigits.indexOf(ndigits) !== -1) return n;
    }
    return null;
  }

  async function decorate(btn, info) {
    // Look up contact by phone, replace number text with contact name.
    if (!info || !info.digits) return;
    const resp = await send({ type: 'lookupContact', number: info.digits });
    if (resp && resp.ok && resp.contact) {
      const label = resp.contact.company
        ? `${resp.contact.name} · ${resp.contact.company}`
        : resp.contact.name;
      const tn = findPhoneTextNode(info.container, info.raw);
      if (tn && tn.parentElement && tn.parentElement.getAttribute(ATTR_RENAMED) !== '1') {
        tn.parentElement.setAttribute(ATTR_RENAMED, '1');
        if (!tn.parentElement.getAttribute(ATTR_ORIG)) {
          tn.parentElement.setAttribute(ATTR_ORIG, tn.nodeValue);
        }
        tn.nodeValue = label;
        tn.parentElement.title = `${resp.contact.name} — ${info.raw}`;
      }
    }
  }

  function hook(btn, kind) {
    if (!btn || btn.getAttribute(ATTR_HOOKED) === kind) return;
    btn.setAttribute(ATTR_HOOKED, kind);
    btn.addEventListener(
      'click',
      () => {
        // Re-resolve number at click time (DOM may have updated).
        const info = findNumberNear(btn) || readStoredNumber(btn);
        if (!info || !info.digits) return;
        send({ type: kind === 'accept' ? 'callAccepted' : 'callRejected', number: info.digits });
      },
      true
    );
  }

  function readStoredNumber(btn) {
    const d = btn.getAttribute(ATTR_NUM);
    return d ? { digits: d, raw: d, container: btn.parentElement } : null;
  }

  function classify(el) {
    const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '')
      .trim()
      .slice(0, 60);
    if (!txt) {
      // Buttons may be icon-only; check title / aria-label / class hints.
      const hint =
        (el.getAttribute('aria-label') || '') + ' ' + (el.className || '') + ' ' + (el.id || '');
      if (/accept|answer/i.test(hint)) return 'accept';
      if (/reject|decline|hang/i.test(hint)) return 'reject';
      return null;
    }
    if (ACCEPT_RE.test(txt)) return 'accept';
    if (REJECT_RE.test(txt)) return 'reject';
    return null;
  }

  function scanDoc(doc) {
    if (!doc) return;
    // Candidates: buttons, anchors, role=button. Limit to visible ones.
    const candidates = doc.querySelectorAll(
      'button, a, [role="button"], .btn, [onclick]'
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const kind = classify(el);
      if (!kind) continue;
      const info = findNumberNear(el);
      if (info) {
        // Stash digits on the button so click handler can recover them.
        el.setAttribute(ATTR_NUM, info.digits);
        if (kind === 'accept') decorate(el, info);
      }
      hook(el, kind);
    }
  }

  function scanAll() {
    scanDoc(document);
    // Same-origin iframes (e.g. /WebPhone/ embedded in /app/) — content script
    // already injects into them via all_frames, but scan defensively too.
    const frames = document.querySelectorAll('iframe');
    for (const f of frames) {
      try {
        const d = f.contentDocument;
        if (d) scanDoc(d);
      } catch (_) {
        /* cross-origin, ignore */
      }
    }
  }

  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scanAll();
    }, 80);
  }

  const observer = new MutationObserver(scheduleScan);

  function start() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['style', 'class', 'aria-hidden', 'aria-label', 'title']
    });
    scanAll();
    // Periodic safety net for SPA frameworks that swap DOM without triggering
    // mutations we observed.
    setInterval(scanAll, 1500);
  }

  // ---------------- WebPhone auto-heal ----------------
  // Runs only in the top frame (the /app/ page). The /WebPhone/ iframe is
  // same-origin so we can reach into it via iframe.contentDocument.

  const SETTINGS_DEFAULT = { autoHealEnabled: false, autoHealIntervalSec: 60 };
  let healTimer = null;
  let healBusy = false;
  let lastHealAt = 0;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function getWebPhoneDoc() {
    const ifr = document.querySelector(
      'iframe[src*="/WebPhone/"], iframe[src*="/webphone/"], iframe[name="WebPhone"]'
    );
    if (!ifr) return null;
    try { return ifr.contentDocument || null; } catch (_) { return null; }
  }

  function findSettingsTab(doc) {
    const tabs = doc.querySelectorAll('.TabbedPanelsTab, li.TabbedPanelsTab');
    for (const t of tabs) {
      if ((t.textContent || '').trim() === '⚙') return t;
    }
    return null;
  }

  function findPhoneTab(doc) {
    return doc.getElementById('PhoneTabLink');
  }

  function readLogLatestLine(doc) {
    const log = doc.getElementById('ListPhoneLog');
    if (!log) return '';
    const text = (log.value != null ? log.value : log.textContent) || '';
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  }

  function findRestartButton() {
    // The "WebPhone" nav button in the parent /app/ page that re-opens the
    // eModal iframe. The page also has another element with id="profile-tab"
    // (the Profile/cog tab), so id alone is ambiguous — match by the
    // onclick that calls eModal.iframe('/WebPhone/', ...) / checkDevices().
    const candidates = document.querySelectorAll('a[onclick], button[onclick]');
    for (const el of candidates) {
      const oc = el.getAttribute('onclick') || '';
      if (/eModal\.iframe\(\s*['"]\/WebPhone\//i.test(oc)) return el;
      if (/checkDevices\s*\(/i.test(oc) && /WebPhone/i.test(oc)) return el;
    }
    // Fall back to title="WebPhone".
    const titled = document.querySelector('a[title="WebPhone"], button[title="WebPhone"]');
    if (titled) return titled;
    return null;
  }

  async function waitForSwalConfirm(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = document.querySelector('.swal2-confirm');
      if (ok && isVisible(ok)) return ok;
      await sleep(120);
    }
    return null;
  }

  async function healTick() {
    if (healBusy) return;
    healBusy = true;
    try {
      const doc = getWebPhoneDoc();
      if (!doc) return;
      const settingsTab = findSettingsTab(doc);
      if (settingsTab) {
        settingsTab.click();
        await sleep(450);
      }
      const latest = readLogLatestLine(doc);
      if (!latest) return;
      if (/Connection closed to Server WebRTC/i.test(latest)) {
        const btn = findRestartButton();
        if (btn) {
          btn.click();
          const ok = await waitForSwalConfirm(4000);
          if (ok) ok.click();
        }
      } else if (/Success to connect to Server WebRTC/i.test(latest)) {
        // Already connected — return to the phone tab so the user sees the dialer.
        const phoneTab = findPhoneTab(doc);
        if (phoneTab) phoneTab.click();
      }
      lastHealAt = Date.now();
    } catch (err) {
      // Swallow — auto-heal must never break the page.
      console.debug('[2ndNumber] heal tick error', err);
    } finally {
      healBusy = false;
    }
  }

  function applyHealSettings(settings) {
    const s = { ...SETTINGS_DEFAULT, ...(settings || {}) };
    if (healTimer) { clearInterval(healTimer); healTimer = null; }
    if (!s.autoHealEnabled) return;
    const ms = Math.max(10, Math.min(3600, s.autoHealIntervalSec || 60)) * 1000;
    healTimer = setInterval(healTick, ms);
  }

  function setupAutoHeal() {
    if (window.top !== window) return; // top frame only
    try {
      chrome.runtime.sendMessage({ type: 'getSettings' }, (resp) => {
        void chrome.runtime.lastError;
        applyHealSettings(resp && resp.settings);
      });
    } catch (_) { /* extension context not ready */ }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.settings) return;
        applyHealSettings(changes.settings.newValue);
      });
    } catch (_) { /* ignore */ }
  }

  start();
  setupAutoHeal();
})();
