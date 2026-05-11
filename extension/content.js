// Content script for https://www.2ndnumber.tel/app/* and /WebPhone/* (incl. iframes).
// The incoming-call UI is rendered inside the /WebPhone/ iframe and uses
// unknown / dynamic selectors, so we detect it heuristically: any visible
// element that looks like an Accept button (text "Accept", "Answer", phone
// glyph) plus a phone-number-shaped string nearby.
(function () {
  'use strict';

  // -------- Debug helper --------
  // Turn on at runtime via the page console:
  //   localStorage.setItem('tn-debug','1'); location.reload();
  // Then watch the console for [TN] lines.
  const DBG = (() => {
    try { return localStorage.getItem('tn-debug') === '1'; } catch (_) { return false; }
  })();
  const FRAME = (() => {
    try {
      const p = location.pathname || '';
      if (p.indexOf('/WebPhone/') !== -1) return 'WebPhone';
      return window.top === window ? 'top' : 'frame';
    } catch (_) { return 'frame'; }
  })();
  function dbg(...args) { if (DBG) try { console.log('[TN:' + FRAME + ']', ...args); } catch (_) {} }
  if (DBG) dbg('content script booted at', location.href);

  const ATTR_ORIG = 'data-tn-original';
  const ATTR_HOOKED = 'data-tn-hooked';
  const ATTR_RENAMED = 'data-tn-renamed';
  const ATTR_NUM = 'data-tn-number';

  // Match common US/intl formats: +1 (555) 555-1234, 555-555-1234, 5555551234, etc.
  const PHONE_RE = /(\+?\d[\d\s().\-]{7,}\d)/;
  const ACCEPT_RE = /\b(accept|answer|pick\s*up|receive)\b/i;
  const REJECT_RE = /\b(reject|decline|hang\s*up|ignore|end)\b/i;
  // VaxPhone uses <input id="BtnAccept"> / <input id="BtnReject"> inside
  // #incomingModal. Match the id/name/value directly.
  const ID_ACCEPT_RE = /btn[_-]?accept|^accept$|answer/i;
  const ID_REJECT_RE = /btn[_-]?reject|^reject$|decline|hangup/i;

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
    // Last resort: scan every select/option in the whole document. We
    // intentionally do NOT require the select to be visible \u2014 VaxPhone uses
    // a hidden <select id=\"ListIncomingCall\"> as a data store.
    const doc = el.ownerDocument || document;
    for (const sel of doc.querySelectorAll('select')) {
      for (const opt of sel.options || []) {
        const p = extractPhoneFromText(opt.textContent);
        if (p) return { ...p, container: sel.parentElement || sel, source: opt };
      }
    }
    // And as the very last resort, scan any visible incoming-call modal text.
    const modal = doc.getElementById('incomingModal') || doc.querySelector('.modal.show, [id*=\"ncoming\" i]');
    if (modal) {
      const p = extractPhoneFromText(modal.textContent);
      if (p) return { ...p, container: modal };
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
    dbg('hook', kind, btn.tagName + (btn.id ? '#' + btn.id : ''), 'value=', btn.value || '', 'storedNum=', btn.getAttribute(ATTR_NUM));
    let lastFiredAt = 0;
    const fire = (ev) => {
      const now = Date.now();
      if (now - lastFiredAt < 800) return; // dedupe pointerdown/mousedown/click
      lastFiredAt = now;
      // Prefer the digits we stashed at scan time. Re-scanning the DOM here is
      // unreliable because `decorate` may have replaced the visible phone text
      // with the contact name, causing findNumberNear to fall through and pick
      // up a different number on the page (e.g. the receiver's own line).
      const info = readStoredNumber(btn) || findNumberNear(btn);
      dbg(kind + ' fired (' + ev.type + ') number=', info && info.digits);
      if (!info || !info.digits) return;
      send({ type: kind === 'accept' ? 'callAccepted' : 'callRejected', number: info.digits });
    };
    // Listen on multiple events because VaxPhone may dispatch synthetic clicks
    // or handle pointerdown/mousedown before click bubbles.
    btn.addEventListener('click', fire, true);
    btn.addEventListener('mousedown', fire, true);
    btn.addEventListener('pointerdown', fire, true);
  }

  function readStoredNumber(btn) {
    const d = btn.getAttribute(ATTR_NUM);
    return d ? { digits: d, raw: d, container: btn.parentElement } : null;
  }

  function classify(el) {
    // Identity hints first — works for icon-only / value-only buttons like
    // <input id="BtnAccept" value="Accept">.
    const ident = [
      el.id || '',
      el.name || '',
      el.value || '',
      el.getAttribute('aria-label') || '',
      el.title || '',
      el.className || ''
    ].join(' ');
    // VaxPhone's BtnDial flips its value to "Hangup" during an active
    // outbound (or any) call. We must NOT treat that as a "reject" — doing
    // so records the dialed number as a Rejected history entry every time
    // the user ends their own outbound call. The dial/hangup button lives
    // outside the #incomingModal, so the safest filter is: only hook
    // accept/reject behavior on elements whose id is explicitly BtnAccept /
    // BtnReject, or that are inside #incomingModal.
    const id = el.id || '';
    if (/^BtnDial$/i.test(id)) return null;
    const inIncomingModal = !!el.closest('#incomingModal');
    const isBtnAccept = /^BtnAccept$/i.test(id);
    const isBtnReject = /^BtnReject$/i.test(id);
    if (!inIncomingModal && !isBtnAccept && !isBtnReject) return null;

    if (ID_ACCEPT_RE.test(ident)) return 'accept';
    if (ID_REJECT_RE.test(ident)) return 'reject';

    const txt = (el.innerText || el.textContent || '').trim().slice(0, 60);
    if (txt) {
      if (ACCEPT_RE.test(txt)) return 'accept';
      if (REJECT_RE.test(txt)) return 'reject';
    }
    return null;
  }

  function scanDoc(doc) {
    if (!doc) return;
    // Reset stashed caller digits on any Accept/Reject button that is no
    // longer visible — i.e. the previous incoming-call UI was dismissed.
    // This lets the next call capture fresh digits instead of reusing the
    // stale ones from the prior call.
    try {
      const stashed = doc.querySelectorAll('[' + ATTR_NUM + ']');
      for (const el of stashed) {
        if (!isVisible(el)) {
          el.removeAttribute(ATTR_NUM);
          // Also revert any in-place rename so the next call's number/name
          // is re-derived from scratch.
          const renamed = doc.querySelectorAll('[' + ATTR_RENAMED + ']');
          for (const r of renamed) {
            const orig = r.getAttribute(ATTR_ORIG);
            if (orig != null) {
              // Find the first text node and restore it.
              for (const child of r.childNodes) {
                if (child.nodeType === 3) { child.nodeValue = orig; break; }
              }
            }
            r.removeAttribute(ATTR_RENAMED);
            r.removeAttribute(ATTR_ORIG);
            r.removeAttribute('title');
          }
        }
      }
    } catch (_) { /* ignore */ }

    // Candidates: buttons, anchors, role=button, plus <input> (VaxPhone uses
    // <input id="BtnAccept">). Limit to visible ones.
    const candidates = doc.querySelectorAll(
      'button, a, [role="button"], .btn, [onclick], input[type="button"], input[type="submit"], input[type="image"], input[id], input[name]'
    );
    let matched = 0;
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const kind = classify(el);
      if (!kind) continue;
      matched++;
      // Once we've stashed the caller's digits on this button, do NOT
      // re-scan / re-decorate. Subsequent scans run after `decorate` has
      // replaced the visible phone text with the contact name, so
      // `findNumberNear` would fall through and pick up an unrelated number
      // on the page (typically the receiver's own line) — overwriting the
      // correct caller digits and causing the popup to prompt to save the
      // receiver's number on Accept.
      const stored = el.getAttribute(ATTR_NUM);
      if (stored) {
        hook(el, kind);
        continue;
      }
      const info = findNumberNear(el);
      dbg('scan match', kind, el.tagName + (el.id ? '#' + el.id : ''), 'number=', info && info.digits);
      if (info) {
        // Stash digits on the button so click handler can recover them.
        el.setAttribute(ATTR_NUM, info.digits);
        if (kind === 'accept') decorate(el, info);
      }
      hook(el, kind);
    }
    if (DBG && matched === 0) {
      // Useful breadcrumb when nothing matched.
      const ba = doc.getElementById && doc.getElementById('BtnAccept');
      if (ba) dbg('BtnAccept exists but did not match. visible=', isVisible(ba), 'id=', ba.id, 'value=', ba.value);
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

  // True when the WebPhone is ringing, on a call, or otherwise in a state
  // we shouldn't interrupt by clicking tabs or the parent restart button.
  function isCallActive(doc) {
    try {
      // Most reliable signal: VaxPhone flips BtnDial's value to "Hangup" while
      // a call is dialing / connected. When idle it reads "Dial".
      const dial = doc.getElementById('BtnDial');
      if (dial && /hang\s*up/i.test(dial.value || '')) return true;
      // Incoming-call modal (visible while ringing).
      const incoming = doc.getElementById('incomingModal');
      if (incoming) {
        const style = incoming.getAttribute('style') || '';
        const displayed = /display\s*:\s*block/i.test(style) ||
          incoming.classList.contains('show');
        // Also require aria-hidden to NOT be true — Bootstrap leaves the modal
        // in the DOM with display:none + aria-hidden=true between calls.
        const hidden = incoming.getAttribute('aria-hidden') === 'true';
        if (displayed && !hidden) return true;
      }
      // Outgoing-call modal, if present.
      const outgoing = doc.getElementById('outgoingModal') || doc.getElementById('OutgoingModal');
      if (outgoing) {
        const s = outgoing.getAttribute('style') || '';
        const hidden = outgoing.getAttribute('aria-hidden') === 'true';
        if ((/display\s*:\s*block/i.test(s) || outgoing.classList.contains('show')) && !hidden) {
          return true;
        }
      }
      // Body has class modal-open AND any .modal.show is the incoming/outgoing dialog.
      if (doc.body && doc.body.classList.contains('modal-open')) {
        const shown = doc.querySelector('.modal.show');
        if (shown && /incoming|outgoing|call/i.test(shown.id || '')) return true;
      }
    } catch (_) { /* ignore */ }
    return false;
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
      dbg('heal tick. webphone doc?', !!doc);
      if (!doc) return;
      // Don't disturb the user while a call is incoming or in progress —
      // clicking the settings/phone tab or the parent WebPhone button would
      // tear down the active SIP session.
      if (isCallActive(doc)) {
        dbg('heal: call active, skipping');
        return;
      }
      const settingsTab = findSettingsTab(doc);
      dbg('heal: settings tab found?', !!settingsTab);
      if (settingsTab) {
        settingsTab.click();
        await sleep(450);
      }
      const latest = readLogLatestLine(doc);
      dbg('heal: latest log line =', JSON.stringify(latest));
      if (!latest) return;
      if (/Connection closed to Server WebRTC/i.test(latest)) {
        const btn = findRestartButton();
        dbg('heal: restart btn found?', !!btn, btn && btn.outerHTML && btn.outerHTML.slice(0, 120));
        if (btn) {
          btn.click();
          const ok = await waitForSwalConfirm(4000);
          dbg('heal: swal confirm found?', !!ok);
          if (ok) ok.click();
        }
      } else {
        // Already connected — return to the phone tab so the user sees the dialer.
        const phoneTab = findPhoneTab(doc);
        dbg('heal: phone tab found?', !!phoneTab);
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
    // Fire one immediate tick so the user sees activity right away after
    // toggling the setting on (don't make them wait a full interval).
    setTimeout(healTick, 1500);
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
