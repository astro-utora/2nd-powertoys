// Options page script
(function () {
  'use strict';
  const TN = window.TN;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const state = { contacts: [], search: '' };

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || { ok: false }); });
    });
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2000);
  }

  // ---- Table ----

  function render() {
    const q = state.search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    const items = state.contacts.filter((c) => {
      if (!q) return true;
      return (
        (c.name || '').toLowerCase().includes(q) ||
        (c.title || '').toLowerCase().includes(q) ||
        (qDigits && (c.phone || '').includes(qDigits)) ||
        (c.phoneDisplay || '').toLowerCase().includes(q) ||
        (c.company || '').toLowerCase().includes(q) ||
        (c.clientName || '').toLowerCase().includes(q)
      );
    });
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    $('#countBadge').textContent = `${items.length} of ${state.contacts.length}`;
    $('#contactsEmpty').classList.toggle('hidden', state.contacts.length > 0);
    $('#contactsTable').classList.toggle('hidden', state.contacts.length === 0);

    $('#contactsBody').innerHTML = items.map((c) => `
      <tr data-id="${TN.escapeHtml(c.id)}">
        <td>
          <div class="name-cell">
            <div class="avatar" style="background:${TN.colorFromString(c.name || c.phone)}">${TN.escapeHtml(TN.initials(c.name))}</div>
            <span>${TN.escapeHtml(c.name)}</span>
          </div>
        </td>
        <td>${TN.escapeHtml(c.title || '—')}</td>
        <td>${TN.escapeHtml(c.phoneDisplay || TN.formatPhone(c.phone))}</td>
        <td>${TN.escapeHtml(TN.roleLabel(c.role) || '—')}</td>
        <td>${TN.escapeHtml(c.company || '—')}</td>
        <td>${TN.escapeHtml(c.clientName || '—')}</td>
        <td>${TN.escapeHtml(c.step || '—')}</td>
        <td>${c.round ? 'R' + c.round : '—'}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
          <button class="btn btn-ghost btn-sm" data-action="delete">Delete</button>
        </td>
      </tr>`).join('');

    $('#contactsBody').querySelectorAll('tr').forEach((tr) => {
      const id = tr.dataset.id;
      tr.addEventListener('click', (e) => {
        const action = e.target.closest('button')?.dataset.action;
        if (action === 'delete') return; // handled below
        openDrawer(id);
      });
      tr.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this contact?')) return;
        await send({ type: 'deleteContact', id });
        toast('Deleted');
        await load();
      });
    });
  }

  // ---- Drawer (same shape as popup) ----

  function openDrawer(id) {
    const drawer = $('#drawer');
    const form = $('#contactForm');
    form.reset();
    $$('.error', form).forEach((e) => (e.textContent = ''));
    const contact = id ? state.contacts.find((c) => c.id === id) : null;
    $('#drawerTitle').textContent = contact ? 'Edit contact' : 'New contact';
    $('#deleteContact').hidden = !contact;
    form.elements.id.value = contact ? contact.id : '';
    form.elements.phone.value = contact ? (contact.phoneDisplay || TN.formatPhone(contact.phone)) : '';
    form.elements.name.value = contact ? contact.name : '';
    form.elements.title.value = contact ? (contact.title || '') : '';
    form.elements.role.value = contact ? (contact.role || '') : '';
    form.elements.company.value = contact ? (contact.company || '') : '';
    form.elements.clientName.value = contact ? (contact.clientName || '') : '';
    form.elements.step.value = contact ? (contact.step || '') : '';
    form.elements.round.value = contact && contact.round ? String(contact.round) : '';
    drawer.classList.remove('hidden');
    $('#drawerScrim').classList.remove('hidden');
    setTimeout(() => form.elements[contact ? 'name' : 'phone'].focus(), 50);
  }
  function closeDrawer() {
    $('#drawer').classList.add('hidden');
    $('#drawerScrim').classList.add('hidden');
  }

  async function submit(ev) {
    ev.preventDefault();
    const form = ev.target;
    $$('.error', form).forEach((e) => (e.textContent = ''));
    const draft = {
      id: form.elements.id.value || undefined,
      phone: form.elements.phone.value,
      name: form.elements.name.value.trim(),
      title: form.elements.title.value.trim(),
      role: form.elements.role.value,
      company: form.elements.company.value.trim(),
      clientName: form.elements.clientName.value.trim(),
      step: form.elements.step.value,
      round: form.elements.round.value
    };
    const resp = await send({ type: 'saveContact', draft });
    if (!resp.ok) {
      const errs = resp.errors || { _: resp.error || 'Save failed' };
      Object.entries(errs).forEach(([k, v]) => {
        const el = form.querySelector(`.error[data-error="${k}"]`);
        if (el) el.textContent = v;
      });
      return;
    }
    closeDrawer();
    toast(draft.id ? 'Updated' : 'Saved');
    await load();
  }

  async function deleteCurrent() {
    const id = $('#contactForm').elements.id.value;
    if (!id) return;
    if (!confirm('Delete this contact?')) return;
    await send({ type: 'deleteContact', id });
    closeDrawer();
    toast('Deleted');
    await load();
  }

  // ---- Import / Export ----

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const data = state.contacts.map(({ id, createdAt, updatedAt, ...rest }) => rest);
    download('2ndnumber-contacts.json', JSON.stringify(data, null, 2), 'application/json');
  }

  const CSV_COLS = ['name', 'title', 'phone', 'role', 'company', 'clientName', 'step', 'round'];
  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function exportCsv() {
    const header = CSV_COLS.join(',');
    const rows = state.contacts.map((c) =>
      CSV_COLS.map((k) => csvEscape(k === 'phone' ? (c.phoneDisplay || TN.formatPhone(c.phone)) : c[k])).join(',')
    );
    download('2ndnumber-contacts.csv', [header, ...rows].join('\n'), 'text/csv');
  }

  function parseCsv(text) {
    // Simple CSV parser handling quotes & commas.
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(cur); cur = ''; }
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          row.push(cur); rows.push(row); row = []; cur = '';
        } else cur += ch;
      }
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows.shift().map((h) => h.trim());
    return rows
      .filter((r) => r.some((v) => v && v.trim()))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
  }

  async function handleImport(file) {
    const text = await file.text();
    let records;
    try {
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text);
        records = Array.isArray(parsed) ? parsed : (parsed.contacts || []);
      } else {
        records = parseCsv(text);
      }
    } catch (err) {
      toast('Could not parse file');
      return;
    }
    const resp = await send({ type: 'importContacts', contacts: records });
    if (resp.ok) {
      toast(`Imported · added ${resp.added}, updated ${resp.updated}`);
      await load();
    } else {
      toast('Import failed');
    }
  }

  async function load() {
    const resp = await send({ type: 'getContacts' });
    state.contacts = (resp && resp.contacts) || [];
    render();
  }

  async function loadSettings() {
    const resp = await send({ type: 'getSettings' });
    const s = (resp && resp.settings) || {};
    $('#autoHealEnabled').checked = !!s.autoHealEnabled;
    $('#autoHealIntervalSec').value = s.autoHealIntervalSec ?? 60;
    $('#missedScanEnabled').checked = !!s.missedScanEnabled;
    $('#missedScanIntervalMin').value = s.missedScanIntervalMin ?? 15;
    $('#sidebarMode').checked = !!s.sidebarMode;
    refreshSettingsUi(s);
  }

  function refreshSettingsUi(s) {
    const map = {
      sidebarMode: !!s.sidebarMode,
      autoHealEnabled: !!s.autoHealEnabled,
      missedScanEnabled: !!s.missedScanEnabled
    };
    Object.entries(map).forEach(([k, on]) => {
      const pill = document.querySelector(`[data-status-for="${k}"]`);
      if (pill) { pill.textContent = on ? 'On' : 'Off'; pill.classList.toggle('on', on); }
    });
    const sub = $('#settingsSummarySub');
    if (sub) {
      const active = [];
      if (map.sidebarMode) active.push('Side panel');
      if (map.autoHealEnabled) active.push('Auto-heal');
      if (map.missedScanEnabled) active.push('Missed scan');
      sub.textContent = active.length ? `Active: ${active.join(' · ')}` : 'All features off';
    }
  }

  async function saveSettingsClick() {
    const patch = {
      autoHealEnabled: $('#autoHealEnabled').checked,
      autoHealIntervalSec: parseInt($('#autoHealIntervalSec').value, 10) || 60,
      missedScanEnabled: $('#missedScanEnabled').checked,
      missedScanIntervalMin: parseInt($('#missedScanIntervalMin').value, 10) || 15,
      sidebarMode: $('#sidebarMode').checked
    };
    const resp = await send({ type: 'saveSettings', patch });
    if (resp && resp.ok) {
      $('#autoHealIntervalSec').value = resp.settings.autoHealIntervalSec;
      $('#missedScanIntervalMin').value = resp.settings.missedScanIntervalMin;
      refreshSettingsUi(resp.settings);
      flashSaveHint();
      return resp.settings;
    }
    toast('Could not save settings');
    return null;
  }

  function flashSaveHint() {
    const hint = $('#settingsSaveHint');
    if (!hint) return;
    hint.textContent = 'Saved';
    hint.classList.add('saved');
    clearTimeout(flashSaveHint._t);
    flashSaveHint._t = setTimeout(() => {
      hint.textContent = 'Changes save automatically.';
      hint.classList.remove('saved');
    }, 1400);
  }

  async function scanNowClick() {
    const btn = $('#scanNowBtn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Scanning…';
    const resp = await send({ type: 'scanMissedNow' });
    btn.disabled = false;
    btn.textContent = original;
    if (!resp || !resp.ok) {
      toast(resp && resp.error ? `Scan failed · ${resp.error}` : 'Scan failed');
      return;
    }
    const extra = (resp.totalRows != null)
      ? ` · ${resp.totalRows} rows total, ${resp.dupMissed} dup, ${resp.matchedAccepted} matched`
      : '';
    toast(`Scan complete · ${resp.added} added of ${resp.scanned}${extra}`);
    console.log('[2ndNumber] scanMissedNow resp', resp);
  }

  function bind() {
    $('#newContact').addEventListener('click', () => openDrawer(null));
    $('#closeDrawer').addEventListener('click', closeDrawer);
    $('#cancelDrawer').addEventListener('click', closeDrawer);
    $('#drawerScrim').addEventListener('click', closeDrawer);
    $('#contactForm').addEventListener('submit', submit);
    $('#deleteContact').addEventListener('click', deleteCurrent);
    $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; render(); });
    $('#exportJsonBtn').addEventListener('click', exportJson);
    $('#exportCsvBtn').addEventListener('click', exportCsv);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) handleImport(f);
      e.target.value = '';
    });
    $('#saveSettingsBtn')?.addEventListener('click', saveSettingsClick);
    $('#scanNowBtn').addEventListener('click', scanNowClick);
    // Auto-save on any settings change.
    document.querySelectorAll('[data-autosave]').forEach((el) => {
      const ev = el.type === 'checkbox' ? 'change' : 'change';
      el.addEventListener(ev, saveSettingsClick);
      if (el.type === 'number') el.addEventListener('blur', saveSettingsClick);
    });
    $('#sidebarMode').removeEventListener?.('change', () => {});
    $('#sidebarMode').addEventListener('change', () => {
      // status pill update is handled by saveSettingsClick → refreshSettingsUi
    });
    $('#openSidebarNow').addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (chrome.sidePanel && chrome.sidePanel.open) {
          await chrome.sidePanel.open(tab ? { tabId: tab.id, windowId: tab.windowId } : { windowId: chrome.windows.WINDOW_ID_CURRENT });
        } else {
          toast('Side panel API unavailable');
        }
      } catch (err) {
        toast('Open from a browser tab: click the toolbar icon');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#drawer').classList.contains('hidden')) closeDrawer();
    });
  }

  document.addEventListener('DOMContentLoaded', () => { bind(); load(); loadSettings(); });
})();
