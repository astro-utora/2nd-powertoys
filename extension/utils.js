// Shared utilities. Loaded as a classic script in popup/options/content via <script src>.
// Exposes everything on globalThis.TN (TwoNumber).
(function (root) {
  'use strict';

  /** Normalize a phone string to digits only, dropping leading 1 if length is 11. */
  function normalizePhone(input) {
    if (input == null) return '';
    const digits = String(input).replace(/\D+/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits;
  }

  /** Pretty-print a normalized US-ish number; fall back to raw digits. */
  function formatPhone(input) {
    const d = normalizePhone(input);
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    if (d.length > 10) return `+${d}`;
    return d || String(input || '');
  }

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  const ROLES = [
    { value: '', label: '—' },
    { value: 'recruiter', label: 'Recruiter' },
    { value: 'hiring_manager', label: 'Hiring Manager' }
  ];
  const STEPS = [
    { value: '', label: '—' },
    { value: 'HR', label: 'HR' },
    { value: 'Tech', label: 'Tech' },
    { value: 'Final', label: 'Final' }
  ];
  const ROUNDS = [null, 1, 2, 3, 4, 5, 6, 7];

  function roleLabel(value) {
    const r = ROLES.find((x) => x.value === value);
    return r ? r.label : '';
  }

  /** Hash a string to a stable HSL color for avatar chips. */
  function colorFromString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return `hsl(${hue} 65% 55%)`;
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function timeAgo(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  /** Validate a contact draft. Returns { ok, errors }. */
  function validateContact(draft) {
    const errors = {};
    if (!draft || !String(draft.name || '').trim()) errors.name = 'Name is required';
    const phone = normalizePhone(draft && draft.phone);
    if (!phone) errors.phone = 'Phone is required';
    else if (phone.length < 7) errors.phone = 'Phone looks too short';
    if (draft && draft.round != null && draft.round !== '') {
      const r = Number(draft.round);
      if (!Number.isInteger(r) || r < 1 || r > 7) errors.round = 'Round must be 1–7';
    }
    return { ok: Object.keys(errors).length === 0, errors };
  }

  root.TN = {
    normalizePhone,
    formatPhone,
    uuid,
    ROLES,
    STEPS,
    ROUNDS,
    roleLabel,
    colorFromString,
    initials,
    escapeHtml,
    timeAgo,
    validateContact
  };
})(typeof self !== 'undefined' ? self : globalThis);
