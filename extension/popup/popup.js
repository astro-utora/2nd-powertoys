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
    tab: 'contacts',
    historyFilter: 'all',
    contactsPage: 1,
    historyPage: 1
  };

  const PAGE_SIZE = 10;

  function clampPage(page, total) {
    const max = Math.max(1, total);
    return Math.min(Math.max(1, page), max);
  }

  function renderPager(container, totalItems, currentPage, onChange) {
    if (!container) return currentPage;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    const page = clampPage(currentPage, totalPages);
    if (totalItems <= PAGE_SIZE) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return page;
    }
    container.classList.remove('hidden');
    const from = (page - 1) * PAGE_SIZE + 1;
    const to = Math.min(totalItems, page * PAGE_SIZE);
    container.innerHTML = `
      <button class="pager-btn" data-act="prev" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
      <span class="pager-info">${from}–${to} of ${totalItems}</span>
      <button class="pager-btn" data-act="next" ${page === totalPages ? 'disabled' : ''} aria-label="Next page">›</button>
    `;
    container.querySelector('[data-act="prev"]').addEventListener('click', () => {
      onChange(Math.max(1, page - 1));
    });
    container.querySelector('[data-act="next"]').addEventListener('click', () => {
      onChange(Math.min(totalPages, page + 1));
    });
    return page;
  }

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

  async function dialNumber(rawNumber) {
    const digits = TN.normalizePhone(rawNumber);
    if (!digits) {
      toast('No number to dial');
      return;
    }
    toast(`Dialing ${TN.formatPhone(digits)}…`);
    const resp = await send({ type: 'dialNumber', number: digits });
    if (!resp || !resp.ok) toast('Could not dial');
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

    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state.contactsPage = clampPage(state.contactsPage, totalPages);
    const start = (state.contactsPage - 1) * PAGE_SIZE;
    const pageItems = items.slice(start, start + PAGE_SIZE);

    list.innerHTML = pageItems.map(cardHtml).join('');
    state.contactsPage = renderPager($('#contactsPager'), items.length, state.contactsPage, (p) => {
      state.contactsPage = p;
      renderContacts();
      list.scrollTop = 0;
    });
    list.querySelectorAll('.card').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.call-btn')) return;
        openDrawer(el.dataset.id);
      });
    });
    list.querySelectorAll('.call-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dialNumber(btn.dataset.call);
      });
    });
  }

  function cardHtml(c) {
    const tags = [];
    if (c.role) tags.push(`<span class="tag tag-role">${TN.escapeHtml(TN.roleLabel(c.role))}</span>`);
    if (c.step) tags.push(`<span class="tag tag-step">${TN.escapeHtml(c.step)}</span>`);
    if (c.round) tags.push(`<span class="tag tag-round">R${c.round}</span>`);
    if (c.company) tags.push(`<span class="tag">${TN.escapeHtml(c.company)}</span>`);

    const meta = [c.phoneDisplay || TN.formatPhone(c.phone), c.title, c.clientName].filter(Boolean);
    const dialNum = TN.normalizePhone(c.phone);

    return `
      <div class="card" data-id="${TN.escapeHtml(c.id)}">
        <div class="avatar" style="background:${TN.colorFromString(c.name || c.phone)}">${TN.escapeHtml(TN.initials(c.name))}</div>
        <div class="card-main">
          <div class="card-name">${TN.escapeHtml(c.name)}</div>
          <div class="card-meta">${TN.escapeHtml(meta.join(' · '))}</div>
          ${tags.length ? `<div class="card-tags">${tags.join('')}</div>` : ''}
        </div>
        <button class="call-btn" data-call="${TN.escapeHtml(dialNum)}" title="Call ${TN.escapeHtml(TN.formatPhone(c.phone))}" aria-label="Call ${TN.escapeHtml(c.name)}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.8a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.35 1.84.59 2.8.72A2 2 0 0 1 22 16.92z"/></svg>
          Call
        </button>
      </div>`;
  }

  function renderHistory() {
    const list = $('#historyList');
    const filter = state.historyFilter;
    const items = filter === 'all'
      ? state.history
      : state.history.filter((h) => h.action === filter);
    $('#historyEmpty').classList.toggle('hidden', items.length > 0);
    $('#historyCount').textContent = items.length
      ? `${items.length} entr${items.length === 1 ? 'y' : 'ies'}${filter === 'all' ? '' : ' · ' + filter}`
      : '';

    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state.historyPage = clampPage(state.historyPage, totalPages);
    const start = (state.historyPage - 1) * PAGE_SIZE;
    const pageItems = items.slice(start, start + PAGE_SIZE);

    list.innerHTML = pageItems.map(historyHtml).join('');
    state.historyPage = renderPager($('#historyPager'), items.length, state.historyPage, (p) => {
      state.historyPage = p;
      renderHistory();
      list.scrollTop = 0;
    });
    list.querySelectorAll('.call-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dialNumber(btn.dataset.call);
      });
    });
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
    const dialNum = TN.normalizePhone(h.number);
    const callBtn = dialNum
      ? `<button class="call-btn" data-call="${TN.escapeHtml(dialNum)}" title="Call ${TN.escapeHtml(TN.formatPhone(h.number))}" aria-label="Call ${TN.escapeHtml(title)}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.8a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.35 1.84.59 2.8.72A2 2 0 0 1 22 16.92z"/></svg>
          Call
        </button>`
      : '';
    return `
      <div class="history-row">
        <div class="history-dot ${TN.escapeHtml(h.action)}"></div>
        <div class="history-main">
          <div class="history-title">${TN.escapeHtml(title)}</div>
          <div class="history-sub">${TN.escapeHtml(sub)}</div>
        </div>
        ${callBtn}
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
    form.elements.title.value = contact ? (contact.title || '') : '';
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
    $$('.filter-pill').forEach((p) => p.addEventListener('click', () => {
      state.historyFilter = p.dataset.filter;
      state.historyPage = 1;
      $$('.filter-pill').forEach((x) => x.classList.toggle('active', x === p));
      renderHistory();
    }));
    $('#newContact').addEventListener('click', () => openDrawer(null));
    $('#closeDrawer').addEventListener('click', closeDrawer);
    $('#cancelDrawer').addEventListener('click', closeDrawer);
    $('#drawerScrim').addEventListener('click', closeDrawer);
    $('#contactForm').addEventListener('submit', submitContact);
    $('#deleteContact').addEventListener('click', deleteCurrent);
    $('#searchInput').addEventListener('input', (e) => {
      state.search = e.target.value;
      state.contactsPage = 1;
      renderContacts();
    });
    $('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('#clearHistory').addEventListener('click', async () => {
      if (!confirm('Clear all call history?')) return;
      await send({ type: 'clearHistory' });
      await loadHistory();
      toast('History cleared');
    });
    $('#scanNowBtn').addEventListener('click', async () => {
      const btn = $('#scanNowBtn');
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'Scanning…';
      const resp = await send({ type: 'scanMissedNow' });
      btn.disabled = false;
      btn.textContent = orig;
      if (!resp || !resp.ok) {
        toast(resp && resp.error ? `Scan failed · ${resp.error}` : 'Scan failed');
        return;
      }
      toast(`Scan complete · ${resp.added} added`);
      await loadHistory();
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
    // Sidebar/side-panel layout tweak.
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('mode') === 'sidebar') document.body.classList.add('mode-sidebar');
    } catch (_) { /* ignore */ }
    bind();
    await Promise.all([loadContacts(), loadPending()]);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
