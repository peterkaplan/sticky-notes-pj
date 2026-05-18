// === Sticky Note PWA ===
// Cloud-synced shared list via a Cloudflare Worker.
// localStorage is an offline cache. Cookie remembers unlock.

(() => {
  'use strict';

  // ---- Config ----
  // No password lives here — the server is the only place the password is checked.
  // The gate sends the password to /auth and gets back an opaque session token.
  const API_BASE = 'https://sticky-notes-pj.phkap96.workers.dev';
  const SESSION_KEY = 'stickyNoteSession_v1';
  const STORAGE_KEY = 'stickyNoteItems_v1';
  const VERSION_KEY = 'stickyNoteVersion_v1';
  const COLOR_KEY = 'stickyBackgroundColor_v1';
  const OWNER_KEY = 'stickyLastOwner_v1';
  const POLL_INTERVAL_MS = 8000;

  function getSession() { return localStorage.getItem(SESSION_KEY); }
  function setSession(t) { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY); }

  const BACKGROUND_COLORS = [
    { name: 'yellow', hex: '#ffdc4d', dark: false },
    { name: 'orange', hex: '#ff9f40', dark: false },
    { name: 'pink',   hex: '#ffb3c6', dark: false },
    { name: 'green',  hex: '#a3e4a3', dark: false },
    { name: 'blue',   hex: '#7dc4ff', dark: false },
    { name: 'purple', hex: '#c8a2ff', dark: false },
    { name: 'cyan',   hex: '#80e3e0', dark: false },
    { name: 'white',  hex: '#ffffff', dark: false },
  ];

  const OWNERS = ['P', 'J', 'PJ'];

  const LOVE_NOTES = [
    'loml 💕', "you're beautiful", 'my forever', 'best friend',
    'my person 🤍', 'soulmate', 'my happy place', 'always & forever',
    "you're my fave", 'lucky in love', 'meant to be', 'my everything',
    'love you more', 'dream come true', 'better together', 'my heart 💗',
    'endlessly yours', 'my sunshine ☀️', 'love of my life', 'forever yours',
  ];

  // (Cookie helpers removed — auth is now a server-issued session token in localStorage.)

  // ---- UUID ----
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // ---- Storage ----
  const Store = {
    loadItems() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        return JSON.parse(raw);
      } catch (e) {
        return [];
      }
    },
    saveItems(items) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
    },
    loadVersion() {
      const v = parseInt(localStorage.getItem(VERSION_KEY) || '0', 10);
      return Number.isFinite(v) ? v : 0;
    },
    saveVersion(v) { localStorage.setItem(VERSION_KEY, String(v)); },
    loadColor() {
      const v = localStorage.getItem(COLOR_KEY);
      if (!v) return BACKGROUND_COLORS[0];
      const found = BACKGROUND_COLORS.find(c => c.name === v);
      return found || BACKGROUND_COLORS[0];
    },
    saveColor(c) { localStorage.setItem(COLOR_KEY, c.name); },
    loadOwner() {
      const v = localStorage.getItem(OWNER_KEY);
      return OWNERS.includes(v) ? v : 'P';
    },
    saveOwner(o) { localStorage.setItem(OWNER_KEY, o); },
  };

  // ---- Color luminance ----
  function isDark(hex) {
    // Convert hex to brightness 0..1, return true if dark text should be used (light bg => dark text).
    const m = hex.replace('#', '');
    const r = parseInt(m.substring(0, 2), 16) / 255;
    const g = parseInt(m.substring(2, 4), 16) / 255;
    const b = parseInt(m.substring(4, 6), 16) / 255;
    const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
    return brightness < 0.5; // true => bg is dark => use white text
  }

  // ---- Cloud API ----
  function authHeaders() {
    const t = getSession();
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  }
  function handle401(res) {
    if (res.status === 401) {
      setSession(null);
      showGate();
      throw new Error('session expired');
    }
  }
  const API = {
    async get() {
      const res = await fetch(`${API_BASE}/notes`, { headers: authHeaders() });
      handle401(res);
      if (!res.ok) throw new Error('api get ' + res.status);
      return res.json();
    },
    async put(items, baseVersion) {
      const res = await fetch(`${API_BASE}/notes`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, baseVersion }),
      });
      handle401(res);
      if (!res.ok) throw new Error('api put ' + res.status);
      return res.json();
    },
  };

  // ---- State ----
  let state = {
    items: [],
    version: 0,
    color: BACKGROUND_COLORS[0],
    owner: 'P',
    activeTab: 'today',
    online: navigator.onLine,
    pendingPut: false,
    putQueued: false,
  };

  // ---- Element refs ----
  const $ = id => document.getElementById(id);

  // ---- Gate ----
  function showGate() {
    $('gate').classList.remove('hidden');
    $('app').classList.add('hidden');
    setTimeout(() => $('gate-input').focus(), 100);
  }
  function unlock() {
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    init();
  }
  function checkGate() {
    if (getSession()) {
      $('gate').classList.add('hidden');
      $('app').classList.remove('hidden');
      init();
    } else {
      showGate();
    }
  }

  $('gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = $('gate-form').querySelector('button[type="submit"]');
    const input = $('gate-input');
    const err = $('gate-error');
    const password = input.value;
    if (!password) return;
    submitBtn.disabled = true;
    err.textContent = '';
    try {
      const res = await fetch(`${API_BASE}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const mins = Math.ceil((data.retryAfter || 600) / 60);
        err.textContent = `Locked out — try again in ${mins} min`;
      } else if (!res.ok) {
        err.textContent = 'Try again';
        input.value = '';
        input.focus();
      } else {
        const data = await res.json();
        setSession(data.token);
        unlock();
      }
    } catch {
      err.textContent = 'Network error — try again';
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- Apply theme color ----
  function applyColor(c) {
    document.documentElement.style.setProperty('--bg', c.hex);
    document.documentElement.setAttribute('data-dark', isDark(c.hex) ? 'true' : 'false');
    document.querySelector('meta[name="theme-color"]').setAttribute('content', c.hex);
    $('color-btn').style.background = c.hex;
  }

  // ---- Render ----
  function counts() {
    return {
      today: state.items.filter(i => i.priority === 'today' && !i.isStrikethrough).length,
      thisWeek: state.items.filter(i => i.priority === 'thisWeek' && !i.isStrikethrough).length,
      archive: state.items.filter(i => i.isStrikethrough).length,
    };
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function timeAgo(timestamp) {
    if (!timestamp) return '';
    const diff = (Date.now() - timestamp) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    if (diff < 2592000) return Math.floor(diff / 604800) + 'w ago';
    if (diff < 31536000) return Math.floor(diff / 2592000) + 'mo ago';
    return Math.floor(diff / 31536000) + 'y ago';
  }

  function renderRow(item, opts) {
    const { isArchive } = opts;
    const div = document.createElement('div');
    div.className = 'row' + (item.isStrikethrough && !isArchive ? ' strike' : '') + (opts.isLater ? ' later' : '') + (isArchive ? ' archive' : '');
    div.dataset.id = item.id;

    const bg = document.createElement('div');
    bg.className = 'row-bg';
    bg.innerHTML = `
      <div class="left">${isArchive ? '↶' : (item.isStrikethrough ? '↶' : '✓')}</div>
      <div class="right">🗑</div>
    `;
    div.appendChild(bg);

    const content = document.createElement('div');
    content.className = 'row-content';

    const badge = document.createElement('div');
    badge.className = 'owner-badge ' + item.owner;
    badge.textContent = item.owner;
    content.appendChild(badge);

    if (isArchive) {
      const block = document.createElement('div');
      block.className = 'row-text-block';
      const tx = document.createElement('div');
      tx.className = 'row-text';
      tx.textContent = item.text;
      const meta = document.createElement('div');
      meta.className = 'archive-meta';
      const by = item.archivedBy ? `<span class="archive-by ${item.archivedBy}">by ${item.archivedBy}</span>` : '';
      meta.innerHTML = `${by}<span class="archive-time">${timeAgo(item.archivedAt)}</span>`;
      block.appendChild(tx);
      block.appendChild(meta);
      content.appendChild(block);

      const check = document.createElement('div');
      check.className = 'archive-check';
      check.textContent = '✓';
      content.appendChild(check);
    } else {
      const tx = document.createElement('div');
      tx.className = 'row-text';
      tx.textContent = item.text;
      content.appendChild(tx);

      const moveBtn = document.createElement('button');
      moveBtn.className = 'move-btn';
      moveBtn.textContent = opts.isLater ? '⬆' : '⬇';
      moveBtn.setAttribute('aria-label', opts.isLater ? 'Move to Today' : 'Move to This Week');
      moveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        movePriority(item.id, opts.isLater ? 'today' : 'thisWeek');
      });
      content.appendChild(moveBtn);
    }

    div.appendChild(content);
    attachSwipe(div, content, item, isArchive);
    return div;
  }

  function renderTab(tab) {
    const listEl = $(`list-${tab}`);
    const emptyEl = $(`empty-${tab}`);
    listEl.innerHTML = '';

    let items;
    if (tab === 'today') {
      items = state.items.filter(i => i.priority === 'today' && !i.isStrikethrough);
    } else if (tab === 'thisWeek') {
      items = state.items.filter(i => i.priority === 'thisWeek' && !i.isStrikethrough);
    } else {
      items = state.items.filter(i => i.isStrikethrough).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
    }

    if (items.length === 0) {
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      for (const it of items) {
        listEl.appendChild(renderRow(it, { isArchive: tab === 'archive', isLater: tab === 'thisWeek' }));
      }
    }
  }

  function render() {
    const c = counts();
    $('count-today').textContent = c.today;
    $('count-thisWeek').textContent = c.thisWeek;
    $('count-archive').textContent = c.archive;
    renderTab('today');
    renderTab('thisWeek');
    renderTab('archive');
  }

  // ---- Actions ----
  function persist() {
    Store.saveItems(state.items);
    render();
    schedulePush();
  }

  async function schedulePush() {
    // Coalesce rapid changes: if a put is in flight, queue another.
    if (state.pendingPut) {
      state.putQueued = true;
      return;
    }
    state.pendingPut = true;
    try {
      const res = await API.put(state.items, state.version);
      state.version = res.version;
      Store.saveVersion(state.version);
      // If our PUT was stale, the server already had a newer version. Pull it.
      if (res.stale) {
        await pullFromServer({ silent: true });
      }
    } catch (e) {
      console.warn('push failed', e);
      showToast('Offline — saved locally', true);
    } finally {
      state.pendingPut = false;
      if (state.putQueued) {
        state.putQueued = false;
        schedulePush();
      }
    }
  }

  async function pullFromServer(opts) {
    opts = opts || {};
    try {
      const res = await API.get();
      // If server has a newer version, accept it.
      if (res.version !== state.version || !equalItems(state.items, res.items)) {
        if (res.version >= state.version) {
          state.items = res.items;
          state.version = res.version;
          Store.saveItems(state.items);
          Store.saveVersion(state.version);
          render();
        }
      }
    } catch (e) {
      if (!opts.silent) console.warn('pull failed', e);
    }
  }

  function equalItems(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.id !== y.id || x.text !== y.text || x.isStrikethrough !== y.isStrikethrough ||
          x.owner !== y.owner || x.priority !== y.priority ||
          x.archivedAt !== y.archivedAt || x.archivedBy !== y.archivedBy) return false;
    }
    return true;
  }

  function addItem(priority) {
    const text = $('new-text').value.trim();
    if (!text) return;
    const item = {
      id: uuid(),
      text,
      isStrikethrough: false,
      owner: state.owner,
      priority,
      archivedAt: null,
      archivedBy: null,
    };
    state.items.push(item);
    $('new-text').value = '';
    updateSendButton();
    persist();
  }

  function toggleStrike(id) {
    const it = state.items.find(i => i.id === id);
    if (!it) return;
    it.isStrikethrough = !it.isStrikethrough;
    if (it.isStrikethrough) {
      it.archivedAt = Date.now();
      it.archivedBy = state.owner;
    } else {
      it.archivedAt = null;
      it.archivedBy = null;
    }
    persist();
  }

  function deleteItem(id) {
    state.items = state.items.filter(i => i.id !== id);
    persist();
  }

  function movePriority(id, newPriority) {
    const it = state.items.find(i => i.id === id);
    if (!it) return;
    it.priority = newPriority;
    haptic('medium');
    persist();
  }

  function restoreItem(id) {
    const it = state.items.find(i => i.id === id);
    if (!it) return;
    it.isStrikethrough = false;
    it.archivedAt = null;
    it.archivedBy = null;
    haptic('light');
    persist();
  }

  // ---- Haptics (vibration) ----
  function haptic(kind) {
    if (!('vibrate' in navigator)) return;
    if (kind === 'light') navigator.vibrate(8);
    else if (kind === 'medium') navigator.vibrate(15);
    else if (kind === 'heavy') navigator.vibrate([20, 40, 20]);
    else if (kind === 'success') navigator.vibrate([10, 30, 10, 30, 50]);
  }

  // ---- Swipe gesture ----
  function attachSwipe(rowEl, contentEl, item, isArchive) {
    let startX = 0, startY = 0, dx = 0, dy = 0;
    let active = false, locked = null;
    const STRIKE_THRESH = 100;
    const DEL_THRESH = -100;

    const onStart = (e) => {
      const t = e.touches ? e.touches[0] : e;
      startX = t.clientX; startY = t.clientY;
      dx = 0; dy = 0; active = true; locked = null;
      contentEl.classList.remove('snap');
    };
    const onMove = (e) => {
      if (!active) return;
      const t = e.touches ? e.touches[0] : e;
      dx = t.clientX - startX;
      dy = t.clientY - startY;
      if (locked === null) {
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
          locked = 'x';
          rowEl.classList.add('swiping');
        } else if (Math.abs(dy) > 8) locked = 'y';
      }
      if (locked === 'x') {
        if (e.cancelable) e.preventDefault();
        contentEl.style.transform = `translateX(${dx}px)`;
      }
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      contentEl.classList.add('snap');
      if (locked === 'x') {
        if (dx > STRIKE_THRESH) {
          if (isArchive) restoreItem(item.id);
          else toggleStrike(item.id);
          haptic('light');
        } else if (dx < DEL_THRESH) {
          deleteItem(item.id);
          haptic('medium');
        }
      }
      contentEl.style.transform = '';
      setTimeout(() => rowEl.classList.remove('swiping'), 250);
    };

    contentEl.addEventListener('touchstart', onStart, { passive: true });
    contentEl.addEventListener('touchmove', onMove, { passive: false });
    contentEl.addEventListener('touchend', onEnd);
    contentEl.addEventListener('touchcancel', onEnd);

    // Mouse fallback for desktop testing
    let mouseDown = false;
    contentEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.move-btn')) return;
      mouseDown = true;
      onStart(e);
    });
    window.addEventListener('mousemove', (e) => { if (mouseDown) onMove(e); });
    window.addEventListener('mouseup', () => { if (mouseDown) { mouseDown = false; onEnd(); } });
  }

  // ---- Tabs ----
  function setTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  }

  // ---- Owner pills ----
  function setOwner(o) {
    state.owner = o;
    Store.saveOwner(o);
    document.querySelectorAll('.owner-pill').forEach(p => p.classList.toggle('selected', p.dataset.owner === o));
    // Update send button color
    const ownerColor = { P: 'var(--owner-p)', J: 'var(--owner-j)', PJ: 'var(--owner-pj)' }[o];
    document.documentElement.style.setProperty('--send-color', ownerColor);
    const btn = $('send-btn');
    if (!btn.classList.contains('disabled')) btn.style.background = ownerColor;
  }

  function updateSendButton() {
    const btn = $('send-btn');
    const hasText = $('new-text').value.trim().length > 0;
    btn.classList.toggle('disabled', !hasText);
    const ownerColor = { P: 'var(--owner-p)', J: 'var(--owner-j)', PJ: 'var(--owner-pj)' }[state.owner];
    btn.style.background = hasText ? ownerColor : '';
  }

  // ---- Send button: tap vs long-press ----
  function setupSendButton() {
    const btn = $('send-btn');
    const hint = $('send-hint');
    let pressStart = null;
    let longTimer = null;
    let longTriggered = false;
    const LONG_MS = 500;

    const start = (e) => {
      if (btn.classList.contains('disabled')) return;
      pressStart = Date.now();
      longTriggered = false;
      longTimer = setTimeout(() => {
        if (pressStart !== null) {
          longTriggered = true;
          btn.classList.add('long');
          hint.classList.remove('hidden');
          hint.classList.add('visible');
          haptic('medium');
        }
      }, LONG_MS);
    };
    const end = (e) => {
      if (pressStart === null) return;
      clearTimeout(longTimer);
      const wasLong = longTriggered;
      pressStart = null;
      btn.classList.remove('long');
      hint.classList.remove('visible');
      setTimeout(() => hint.classList.add('hidden'), 200);
      if (btn.classList.contains('disabled')) return;
      if (wasLong) {
        setTab('thisWeek');
        addItem('thisWeek');
      } else {
        addItem(state.activeTab === 'thisWeek' ? 'thisWeek' : 'today');
      }
    };
    const cancel = () => {
      clearTimeout(longTimer);
      pressStart = null;
      longTriggered = false;
      btn.classList.remove('long');
      hint.classList.remove('visible');
      setTimeout(() => hint.classList.add('hidden'), 200);
    };

    btn.addEventListener('touchstart', start, { passive: true });
    btn.addEventListener('touchend', end);
    btn.addEventListener('touchcancel', cancel);
    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', end);
    btn.addEventListener('mouseleave', cancel);
  }

  // ---- Color picker ----
  function setupColorPicker() {
    const grid = $('color-grid');
    grid.innerHTML = '';
    for (const c of BACKGROUND_COLORS) {
      const sw = document.createElement('div');
      sw.className = 'color-swatch' + (c.name === state.color.name ? ' selected' : '');
      sw.style.background = c.hex;
      sw.dataset.name = c.name;
      sw.addEventListener('click', () => {
        state.color = c;
        Store.saveColor(c);
        applyColor(c);
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.name === c.name));
        closeColorSheet();
      });
      grid.appendChild(sw);
    }

    $('color-btn').addEventListener('click', openColorSheet);
    $('color-done').addEventListener('click', closeColorSheet);
    document.querySelector('.sheet-backdrop').addEventListener('click', closeColorSheet);
  }
  function openColorSheet() {
    const s = $('color-sheet');
    s.classList.remove('hidden');
    requestAnimationFrame(() => s.classList.add('show'));
  }
  function closeColorSheet() {
    const s = $('color-sheet');
    s.classList.remove('show');
    setTimeout(() => s.classList.add('hidden'), 320);
  }

  // ---- Easter eggs ----
  let tapCount = 0, lastTapTime = 0;
  function setupHeaderTaps() {
    const header = $('header');
    let pressTimer = null;
    let longTriggered = false;

    header.addEventListener('click', (e) => {
      // ignore clicks on tabs or color btn
      if (e.target.closest('.tab') || e.target.closest('.color-btn')) return;
      if (longTriggered) { longTriggered = false; return; }
      const now = Date.now();
      if (now - lastTapTime < 500) tapCount++;
      else tapCount = 1;
      lastTapTime = now;
      if (tapCount >= 5) {
        tapCount = 0;
        triggerHeartBurst();
      }
    });

    const startLong = (e) => {
      if (e.target && (e.target.closest('.tab') || e.target.closest('.color-btn'))) return;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        longTriggered = true;
        triggerLoveMessage();
      }, 1500);
    };
    const cancelLong = () => { clearTimeout(pressTimer); };

    header.addEventListener('touchstart', startLong, { passive: true });
    header.addEventListener('touchend', cancelLong);
    header.addEventListener('touchcancel', cancelLong);
    header.addEventListener('mousedown', startLong);
    header.addEventListener('mouseup', cancelLong);
    header.addEventListener('mouseleave', cancelLong);
  }

  function triggerHeartBurst() {
    haptic('success');
    const overlay = $('heart-burst');
    overlay.innerHTML = '';
    const w = window.innerWidth, h = window.innerHeight;
    const cx = w / 2, cy = h / 2;

    const center = document.createElement('div');
    center.className = 'center-msg';
    center.innerHTML = `<div class="top">P ❤️ J</div><div class="bot">Forever &amp; Always</div>`;
    overlay.appendChild(center);

    overlay.classList.remove('hidden');

    for (let i = 0; i < 22; i++) {
      setTimeout(() => {
        const h_ = document.createElement('div');
        h_.className = 'floating-heart';
        h_.textContent = '❤️';
        const scale = 0.5 + Math.random();
        h_.style.fontSize = (30 * scale) + 'px';
        h_.style.left = cx + 'px';
        h_.style.top = cy + 'px';
        h_.style.opacity = '1';
        overlay.appendChild(h_);
        requestAnimationFrame(() => {
          const angle = Math.random() * Math.PI * 2;
          const dist = 80 + Math.random() * 200;
          const tx = Math.cos(angle) * dist;
          const ty = Math.sin(angle) * dist - 50;
          const rot = (Math.random() - 0.5) * 360;
          h_.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
          h_.style.opacity = '0';
        });
      }, i * 70);
    }
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    }, 2700);
  }

  function triggerLoveMessage() {
    haptic('heavy');
    const m = $('love-message');
    m.classList.remove('hidden');
    requestAnimationFrame(() => m.classList.add('show'));
    const close = () => {
      m.classList.remove('show');
      setTimeout(() => m.classList.add('hidden'), 350);
      m.removeEventListener('click', close);
    };
    m.addEventListener('click', close);
  }

  // ---- Toast ----
  let toastTimer = null;
  function showToast(msg, error) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.toggle('error', !!error);
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.classList.add('hidden'), 250);
    }, 1500);
  }

  // ---- Wedding countdown ----
  function renderCountdown() {
    const el = $('countdown');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const wedding = new Date(2026, 9, 31); // Oct 31, 2026 (month is 0-indexed)
    const diff = Math.max(0, Math.floor((wedding - today) / 86400000));
    if (diff <= 0) {
      el.classList.add('married');
      el.innerHTML = `<div class="big">💒</div><div class="note">Just</div><div class="date">Married!</div>`;
    } else {
      const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
      const note = LOVE_NOTES[dayOfYear % LOVE_NOTES.length];
      el.classList.remove('married');
      el.innerHTML = `<div class="days">${diff}</div><div class="note">${escapeHtml(note)}</div><div class="date">10.31.26 💒</div>`;
    }
  }

  // ---- Tab switching gestures (swipe between panels) ----
  function setupTabSwipe() {
    const content = document.querySelector('.content');
    let startX = 0, startY = 0, active = false, locked = null;
    const TAB_ORDER = ['today', 'thisWeek', 'archive'];

    const onStart = (e) => {
      // ignore if swipe started on a row content (let row swipe handle it)
      if (e.target.closest('.row-content')) return;
      const t = e.touches ? e.touches[0] : e;
      startX = t.clientX; startY = t.clientY;
      active = true; locked = null;
    };
    const onMove = (e) => {
      if (!active) return;
      const t = e.touches ? e.touches[0] : e;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (locked === null && (Math.abs(dx) > 18 || Math.abs(dy) > 18)) {
        locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
    };
    const onEnd = (e) => {
      if (!active) return;
      active = false;
      if (locked !== 'x') return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      const dx = t.clientX - startX;
      if (Math.abs(dx) < 50) return;
      const idx = TAB_ORDER.indexOf(state.activeTab);
      if (dx < 0 && idx < TAB_ORDER.length - 1) setTab(TAB_ORDER[idx + 1]);
      else if (dx > 0 && idx > 0) setTab(TAB_ORDER[idx - 1]);
    };

    content.addEventListener('touchstart', onStart, { passive: true });
    content.addEventListener('touchmove', onMove, { passive: true });
    content.addEventListener('touchend', onEnd);
  }

  // ---- Init ----
  function init() {
    state.items = Store.loadItems();
    state.version = Store.loadVersion();
    state.color = Store.loadColor();
    state.owner = Store.loadOwner();

    applyColor(state.color);

    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
    document.querySelectorAll('.owner-pill').forEach(btn => {
      btn.addEventListener('click', () => setOwner(btn.dataset.owner));
    });
    setOwner(state.owner);

    $('new-text').addEventListener('input', updateSendButton);
    $('new-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addItem(state.activeTab === 'thisWeek' ? 'thisWeek' : 'today');
      }
    });

    setupSendButton();
    setupColorPicker();
    setupHeaderTaps();
    setupTabSwipe();

    renderCountdown();
    setInterval(renderCountdown, 60 * 60 * 1000); // hourly
    render();
    updateSendButton();

    // Initial cloud pull, then poll while visible.
    pullFromServer();
    startPolling();

    // Pull whenever the tab returns to foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pullFromServer();
    });
    window.addEventListener('online', () => {
      pullFromServer();
      if (state.items.length) schedulePush();
    });
  }

  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') pullFromServer({ silent: true });
    }, POLL_INTERVAL_MS);
  }

  document.addEventListener('DOMContentLoaded', checkGate);
})();
