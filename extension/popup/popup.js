// Popup script
(function () {
  'use strict';
  const TN = window.TN;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    contacts: [],
    history: [],
    pendingNumber: null,
    search: '',
    tab: 'contacts'
  };

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || { ok: false });
      });
    });
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 1800);
  }

  // ---- Rendering ----

  function renderContacts() {
    const list = $('#contactsList');
    const q = state.search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    const items = state.contacts.filter((c) => {
      if (!q) return true;
      return (
        (c.name || '').toLowerCase().includes(q) ||
        (qDigits && (c.phone || '').includes(qDigits)) ||
        (c.phoneDisplay || '').toLowerCase().includes(q) ||
        (c.company || '').toLowerCase().includes(q) ||
        (c.clientName || '').toLowerCase().includes(q)
      );
    });
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    $('#contactsEmpty').classList.toggle('hidden', items.length > 0);
    list.innerHTML = items.map(cardHtml).join('');
    list.querySelectorAll('.card').forEach((el) => {
      el.addEventListener('click', () => openDrawer(el.dataset.id));
    });
  }

  function cardHtml(c) {
    const tags = [];
    if (c.role) tags.push(`<span class="tag tag-role">${TN.escapeHtml(TN.roleLabel(c.role))}</span>`);
    if (c.step) tags.push(`<span class="tag tag-step">${TN.escapeHtml(c.step)}</span>`);
    if (c.round) tags.push(`<span class="tag tag-round">R${c.round}</span>`);
    if (c.company) tags.push(`<span class="tag">${TN.escapeHtml(c.company)}</span>`);

    const meta = [c.phoneDisplay || TN.formatPhone(c.phone), c.clientName].filter(Boolean);

    return `
      <div class="card" data-id="${TN.escapeHtml(c.id)}">
        <div class="avatar" style="background:${TN.colorFromString(c.name || c.phone)}">${TN.escapeHtml(TN.initials(c.name))}</div>
        <div class="card-main">
          <div class="card-name">${TN.escapeHtml(c.name)}</div>
          <div class="card-meta">${TN.escapeHtml(meta.join(' · '))}</div>
          ${tags.length ? `<div class="card-tags">${tags.join('')}</div>` : ''}
        </div>
      </div>`;
  }

  function renderHistory() {
    const list = $('#historyList');
    $('#historyEmpty').classList.toggle('hidden', state.history.length > 0);
    $('#historyCount').textContent = state.history.length
      ? `${state.history.length} entr${state.history.length === 1 ? 'y' : 'ies'}`
      : '';
    list.innerHTML = state.history.map(historyHtml).join('');
  }

  function historyHtml(h) {
    // Always re-resolve against the current contacts list. `h.contactName`
    // is a snapshot from record time and can be stale — the contact may
    // have been deleted (in which case we should fall back to showing the
    // phone number only) or renamed (show the current name).
    let contactName = null;
    if (h.number) {
      const norm = TN.normalizePhone(h.number);
      const match = state.contacts.find((c) => TN.normalizePhone(c.phone) === norm);
      if (match) contactName = match.name;
    }
    const title = contactName ? contactName : TN.formatPhone(h.number);
    const label = h.action === 'accepted' ? 'Accepted'
      : h.action === 'rejected' ? 'Rejected'
      : h.action === 'missed' ? 'Missed'
      : (h.action ? h.action[0].toUpperCase() + h.action.slice(1) : '');
    const dur = (typeof h.durationSecs === 'number' && h.durationSecs > 0)
      ? ` · ${h.durationSecs}s`
      : '';
    const sub = (contactName ? `${TN.formatPhone(h.number)} · ` : '') +
      `${label}${dur} · ${TN.timeAgo(h.timestamp)}`;
    return `
      <div class="history-row">
        <div class="history-dot ${TN.escapeHtml(h.action)}"></div>
        <div class="history-main">
          <div class="history-title">${TN.escapeHtml(title)}</div>
          <div class="history-sub">${TN.escapeHtml(sub)}</div>
        </div>
      </div>`;
  }

  function renderPending() {
    const card = $('#pendingCard');
    if (!state.pendingNumber) {
      card.classList.add('hidden');
      return;
    }
    // Don't prompt to save a number that's already a contact (can happen if
    // pendingNumber was set before the contact existed, or normalization
    // changed). Auto-clear it so the badge/popup card disappear.
    const pendingNorm = TN.normalizePhone(state.pendingNumber);
    const existing = state.contacts.find((c) => TN.normalizePhone(c.phone) === pendingNorm);
    if (existing) {
      state.pendingNumber = null;
      send({ type: 'clearPending' });
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    $('#pendingNumber').textContent = TN.formatPhone(state.pendingNumber);
  }

  // ---- Drawer ----

  function openDrawer(id) {
    const drawer = $('#drawer');
    const scrim = $('#drawerScrim');
    const form = $('#contactForm');
    form.reset();
    $$('.error', form).forEach((e) => (e.textContent = ''));
    const contact = id ? state.contacts.find((c) => c.id === id) : null;
    $('#drawerTitle').textContent = contact ? 'Edit contact' : 'New contact';
    $('#deleteContact').hidden = !contact;

    form.elements.id.value = contact ? contact.id : '';
    form.elements.phone.value = contact ? (contact.phoneDisplay || TN.formatPhone(contact.phone)) : (drawer.dataset.prefillPhone || '');
    form.elements.name.value = contact ? contact.name : '';
    form.elements.role.value = contact ? (contact.role || '') : '';
    form.elements.company.value = contact ? (contact.company || '') : '';
    form.elements.clientName.value = contact ? (contact.clientName || '') : '';
    form.elements.step.value = contact ? (contact.step || '') : '';
    form.elements.round.value = contact && contact.round ? String(contact.round) : '';

    drawer.dataset.prefillPhone = '';
    drawer.classList.remove('hidden');
    scrim.classList.remove('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    setTimeout(() => form.elements[contact ? 'name' : 'phone'].focus(), 50);
  }

  function closeDrawer() {
    $('#drawer').classList.add('hidden');
    $('#drawerScrim').classList.add('hidden');
    $('#drawer').setAttribute('aria-hidden', 'true');
  }

  async function submitContact(ev) {
    ev.preventDefault();
    const form = ev.target;
    $$('.error', form).forEach((e) => (e.textContent = ''));
    const draft = {
      id: form.elements.id.value || undefined,
      phone: form.elements.phone.value,
      name: form.elements.name.value.trim(),
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
    if (state.pendingNumber && TN.normalizePhone(state.pendingNumber) === TN.normalizePhone(draft.phone)) {
      await send({ type: 'clearPending' });
      state.pendingNumber = null;
      renderPending();
    }
    closeDrawer();
    toast(draft.id ? 'Contact updated' : 'Contact saved');
    await loadContacts();
  }

  async function deleteCurrent() {
    const form = $('#contactForm');
    const id = form.elements.id.value;
    if (!id) return;
    if (!confirm('Delete this contact?')) return;
    const resp = await send({ type: 'deleteContact', id });
    if (resp.ok) {
      closeDrawer();
      toast('Contact deleted');
      await loadContacts();
    }
  }

  // ---- Data ----

  async function loadContacts() {
    const resp = await send({ type: 'getContacts' });
    state.contacts = (resp && resp.contacts) || [];
    renderContacts();
  }
  async function loadHistory() {
    const resp = await send({ type: 'getHistory' });
    state.history = (resp && resp.history) || [];
    renderHistory();
  }
  async function loadPending() {
    const resp = await send({ type: 'getPending' });
    state.pendingNumber = (resp && resp.pendingNumber) || null;
    renderPending();
  }

  // ---- Tabs ----

  function setTab(name) {
    state.tab = name;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    if (name === 'history') loadHistory();
  }

  // ---- Events ----

  function bind() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
    $('#newContact').addEventListener('click', () => openDrawer(null));
    $('#closeDrawer').addEventListener('click', closeDrawer);
    $('#cancelDrawer').addEventListener('click', closeDrawer);
    $('#drawerScrim').addEventListener('click', closeDrawer);
    $('#contactForm').addEventListener('submit', submitContact);
    $('#deleteContact').addEventListener('click', deleteCurrent);
    $('#searchInput').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderContacts();
    });
    $('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('#clearHistory').addEventListener('click', async () => {
      if (!confirm('Clear all call history?')) return;
      await send({ type: 'clearHistory' });
      await loadHistory();
      toast('History cleared');
    });
    $('#savePending').addEventListener('click', () => {
      if (!state.pendingNumber) return;
      const drawer = $('#drawer');
      drawer.dataset.prefillPhone = TN.formatPhone(state.pendingNumber);
      openDrawer(null);
    });
    $('#dismissPending').addEventListener('click', async () => {
      await send({ type: 'clearPending' });
      state.pendingNumber = null;
      renderPending();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#drawer').classList.contains('hidden')) closeDrawer();
    });
  }

  async function init() {
    bind();
    await Promise.all([loadContacts(), loadPending()]);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
