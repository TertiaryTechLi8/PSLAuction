/* Shared state, websocket, helpers, countries, flag dropdown */
(function () {
  const PSL = (window.PSL = {
    state: { settings: null, teams: [], players: [], auction: null, me: null, admin: null, online: { users: [], visitors: 0 } },
    offset: 0,
    subs: new Set(),
    token: localStorage.getItem('psl_token') || null,
    ws: null,
    pending: new Map(),
    refSeq: 1,
    connected: false,
    views: {},
  });

  // ------------------------------------------------------------ tiny helpers
  PSL.$ = (s, r = document) => r.querySelector(s);
  PSL.$$ = (s, r = document) => [...r.querySelectorAll(s)];
  PSL.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  PSL.now = () => Date.now() + PSL.offset;
  PSL.on = (root, ev, sel, fn) =>
    root.addEventListener(ev, (e) => {
      const t = e.target.closest(sel);
      if (t && root.contains(t)) fn(e, t);
    });
  PSL.team = (id) => PSL.state.teams.find((t) => t.id === id);
  PSL.player = (id) => PSL.state.players.find((p) => p.id === id);
  PSL.isHost = () => PSL.state.me && PSL.state.me.role === 'host';
  PSL.myTeam = () => (PSL.state.me && PSL.state.me.teamId ? PSL.team(PSL.state.me.teamId) : null);

  // money: values are rupees; shown in crore
  PSL.cr = (v) => {
    const neg = v < 0;
    let s = (Math.abs(v) / 1e7).toFixed(3);
    if (s.endsWith('0')) s = s.slice(0, -1);
    return (neg ? '-' : '') + s;
  };
  PSL.money = (v) => (v < 0 ? '-' : '') + 'Rs ' + PSL.cr(Math.abs(v)) + ' Cr';
  PSL.toCr = (v) => Math.round(Number(v) * 1e7);

  PSL.toast = (msg, kind = '') => {
    let root = PSL.$('#toasts');
    if (!root) { root = document.createElement('div'); root.id = 'toasts'; document.body.appendChild(root); }
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3700);
  };

  PSL.modal = (html, { wide = false } = {}) => {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(ov);
    const close = () => { ov.classList.add('out'); setTimeout(() => ov.remove(), 180); };
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    PSL.on(ov, 'click', '[data-close]', close);
    requestAnimationFrame(() => ov.classList.add('in'));
    return { el: ov.firstElementChild, close };
  };

  PSL.confirm = (title, body, okLabel = 'Confirm') =>
    new Promise((res) => {
      const m = PSL.modal(`<h3>${PSL.esc(title)}</h3><p class="mut">${body}</p><div class="row end gap"><button class="btn ghost" data-no>Cancel</button><button class="btn danger" data-yes>${PSL.esc(okLabel)}</button></div>`);
      m.el.querySelector('[data-no]').onclick = () => { m.close(); res(false); };
      m.el.querySelector('[data-yes]').onclick = () => { m.close(); res(true); };
    });

  // ------------------------------------------------------------ countries & flags
  // [code, name]. Flag SVGs are served from /flags/<code>.svg (flag-icons package).
  const TOP = [
    ['pk', 'Pakistan'], ['af', 'Afghanistan'], ['au', 'Australia'], ['bd', 'Bangladesh'], ['gb-eng', 'England'], ['in', 'India'],
    ['nz', 'New Zealand'], ['za', 'South Africa'], ['lk', 'Sri Lanka'], ['wi', 'West Indies'], ['zw', 'Zimbabwe'], ['ie', 'Ireland'],
    ['nl', 'Netherlands'], ['gb-sct', 'Scotland'], ['np', 'Nepal'], ['ae', 'United Arab Emirates'], ['us', 'United States'], ['ca', 'Canada'],
  ];
  const REST = [
    ['ag', 'Antigua and Barbuda'], ['ar', 'Argentina'], ['at', 'Austria'], ['bb', 'Barbados'], ['be', 'Belgium'], ['bm', 'Bermuda'], ['bt', 'Bhutan'],
    ['bw', 'Botswana'], ['br', 'Brazil'], ['bh', 'Bahrain'], ['cn', 'China'], ['ky', 'Cayman Islands'], ['dk', 'Denmark'], ['dm', 'Dominica'],
    ['eg', 'Egypt'], ['fj', 'Fiji'], ['fi', 'Finland'], ['fr', 'France'], ['de', 'Germany'], ['gh', 'Ghana'], ['gr', 'Greece'], ['gd', 'Grenada'],
    ['gg', 'Guernsey'], ['gy', 'Guyana'], ['hk', 'Hong Kong'], ['id', 'Indonesia'], ['im', 'Isle of Man'], ['ir', 'Iran'], ['it', 'Italy'],
    ['jm', 'Jamaica'], ['jp', 'Japan'], ['je', 'Jersey'], ['ke', 'Kenya'], ['kw', 'Kuwait'], ['kn', 'Saint Kitts and Nevis'], ['lc', 'Saint Lucia'],
    ['mw', 'Malawi'], ['my', 'Malaysia'], ['mv', 'Maldives'], ['mx', 'Mexico'], ['ma', 'Morocco'], ['mm', 'Myanmar'], ['na', 'Namibia'],
    ['ng', 'Nigeria'], ['gb-nir', 'Northern Ireland'], ['no', 'Norway'], ['om', 'Oman'], ['pg', 'Papua New Guinea'], ['ph', 'Philippines'],
    ['pl', 'Poland'], ['pt', 'Portugal'], ['qa', 'Qatar'], ['ro', 'Romania'], ['ru', 'Russia'], ['ws', 'Samoa'], ['sa', 'Saudi Arabia'], ['sg', 'Singapore'],
    ['kr', 'South Korea'], ['es', 'Spain'], ['vc', 'Saint Vincent and the Grenadines'], ['se', 'Sweden'], ['ch', 'Switzerland'], ['tz', 'Tanzania'],
    ['th', 'Thailand'], ['tt', 'Trinidad and Tobago'], ['tr', 'Turkey'], ['ug', 'Uganda'], ['vu', 'Vanuatu'], ['gb-wls', 'Wales'], ['zm', 'Zambia'],
  ].sort((a, b) => a[1].localeCompare(b[1]));
  PSL.COUNTRIES = [...TOP, ...REST];
  const NAME = Object.fromEntries(PSL.COUNTRIES.map(([c, n]) => [c, n]));
  PSL.countryName = (c) => NAME[c] || (c ? c.toUpperCase() : 'Unknown');

  const ALIAS = {
    uk: 'gb-eng', 'united kingdom': 'gb-eng', gb: 'gb-eng', eng: 'gb-eng', usa: 'us', america: 'us', uae: 'ae', emirates: 'ae', holland: 'nl',
    'west indian': 'wi', windies: 'wi', wi: 'wi', sa: 'za', rsa: 'za', 'south africa': 'za', sl: 'lk', 'sri lanka': 'lk', nz: 'nz', aus: 'au',
    ban: 'bd', pak: 'pk', afg: 'af', ind: 'in', zim: 'zw', ire: 'ie', sco: 'gb-sct', 'hongkong': 'hk', png: 'pg', 'korea': 'kr',
    'st lucia': 'lc', 'st kitts': 'kn', 'st vincent': 'vc', 'trinidad': 'tt', 'antigua': 'ag', 'saudi': 'sa', 'türkiye': 'tr',
  };
  PSL.resolveCountry = (raw) => {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    if (NAME[s]) return s;
    for (const [c, n] of PSL.COUNTRIES) if (n.toLowerCase() === s) return c;
    if (ALIAS[s]) return ALIAS[s];
    return null;
  };

  PSL.flag = (code, cls = '') => {
    code = (code || '').toLowerCase();
    if (code === 'wi') return `<span class="flag flag-wi ${cls}" title="West Indies">WI</span>`;
    if (!code) return `<span class="flag flag-none ${cls}">?</span>`;
    return `<img class="flag ${cls}" src="/flags/${PSL.esc(code)}.svg" alt="${PSL.esc(PSL.countryName(code))}" loading="lazy" onerror="this.outerHTML='<span class=&quot;flag flag-none&quot;>${PSL.esc(code.toUpperCase())}</span>'">`;
  };

  // team badge: tries /assets/teams/<short>.png then falls back to a colored badge
  PSL.badge = (team, cls = '') => {
    if (!team) return `<span class="tbadge ${cls}"></span>`;
    const s = PSL.esc(team.short);
    return `<span class="tbadge ${cls}" style="--tc:${PSL.esc(team.color)}"><img src="/assets/teams/${PSL.esc(team.id)}.png" alt="" onerror="this.remove()"><b>${s}</b></span>`;
  };

  // searchable dropdown with flags
  PSL.flagSelect = (host, { value = 'pk', onChange, compact = false } = {}) => {
    host.classList.add('fs');
    if (compact) host.classList.add('compact');
    host.innerHTML = `<button type="button" class="fs-btn" aria-haspopup="listbox"><span class="fs-cur"></span><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><div class="fs-pop" hidden><input class="fs-q" type="search" placeholder="Search country" autocomplete="off"><div class="fs-list" role="listbox"></div></div>`;
    const btn = host.querySelector('.fs-btn'), pop = host.querySelector('.fs-pop'), q = host.querySelector('.fs-q'), list = host.querySelector('.fs-list');
    let val = value;
    const cur = () => (host.querySelector('.fs-cur').innerHTML = `${PSL.flag(val)}<span>${PSL.esc(val ? PSL.countryName(val) : 'Choose country')}</span>`);
    const fill = (f = '') => {
      const s = f.toLowerCase();
      list.innerHTML = PSL.COUNTRIES.filter(([c, n]) => !s || n.toLowerCase().includes(s) || c.includes(s))
        .map(([c, n]) => `<button type="button" role="option" class="fs-opt ${c === val ? 'sel' : ''}" data-c="${c}">${PSL.flag(c)}<span>${PSL.esc(n)}</span></button>`).join('') || '<div class="fs-empty">No match</div>';
    };
    const place = () => {
      const r = btn.getBoundingClientRect();
      const h = 300;
      pop.style.left = Math.min(r.left, window.innerWidth - 270) + 'px';
      pop.style.minWidth = Math.max(r.width, 250) + 'px';
      const below = window.innerHeight - r.bottom;
      pop.style.top = below > h || below > r.top ? r.bottom + 6 + 'px' : Math.max(8, r.top - h - 6) + 'px';
    };
    const close = () => { pop.hidden = true; document.removeEventListener('mousedown', outside, true); window.removeEventListener('resize', close); };
    const outside = (e) => { if (!host.contains(e.target)) close(); };
    btn.onclick = () => {
      if (!pop.hidden) return close();
      q.value = ''; fill(); pop.hidden = false; place(); q.focus();
      const sel = list.querySelector('.sel'); if (sel) sel.scrollIntoView({ block: 'center' });
      document.addEventListener('mousedown', outside, true); window.addEventListener('resize', close);
    };
    q.oninput = () => fill(q.value);
    q.onkeydown = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') { const f = list.querySelector('.fs-opt'); if (f) f.click(); e.preventDefault(); } };
    list.onclick = (e) => {
      const o = e.target.closest('.fs-opt'); if (!o) return;
      val = o.dataset.c; cur(); close(); if (onChange) onChange(val);
    };
    host.getValue = () => val;
    host.setValue = (v) => { val = v; cur(); };
    cur();
    return host;
  };

  // ------------------------------------------------------------ network
  PSL.subscribe = (fn) => { PSL.subs.add(fn); return () => PSL.subs.delete(fn); };
  const notify = (info) => PSL.subs.forEach((fn) => { try { fn(info); } catch (e) { console.error(e); } });

  PSL.connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws${PSL.token ? '?token=' + PSL.token : ''}`);
    PSL.ws = ws;
    ws.onopen = () => { PSL.connected = true; notify({ conn: true }); };
    ws.onclose = () => { PSL.connected = false; notify({ conn: true }); setTimeout(PSL.connect, 1500); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'state') {
        PSL.offset = m.serverNow - Date.now();
        const st = PSL.state;
        const info = { playersChanged: !!m.players, firstState: !st.settings };
        st.settings = m.settings; st.teams = m.teams; st.auction = m.auction; st.me = m.me; st.online = m.online;
        if (m.players) st.players = m.players;
        st.admin = m.admin || null;
        if (PSL.token && !m.me) { PSL.token = null; localStorage.removeItem('psl_token'); }
        notify(info);
      } else if (m.type === 'ack') {
        const p = PSL.pending.get(m.ref);
        if (p) { PSL.pending.delete(m.ref); p(m); }
      }
    };
  };

  PSL.send = (obj) => new Promise((resolve) => {
    if (!PSL.ws || PSL.ws.readyState !== 1) return resolve({ ok: false, error: 'Not connected. Reconnecting...' });
    const ref = PSL.refSeq++;
    PSL.pending.set(ref, resolve);
    PSL.ws.send(JSON.stringify({ ...obj, ref }));
    setTimeout(() => { if (PSL.pending.has(ref)) { PSL.pending.delete(ref); resolve({ ok: false, error: 'No reply from server' }); } }, 5000);
  });

  PSL.host = async (action, body = {}) => {
    try {
      const r = await fetch('/api/host/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + PSL.token }, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) { return { ok: false, error: 'Network error' }; }
  };

  PSL.login = async (username, password) => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const j = await r.json();
    if (j.ok) {
      PSL.token = j.token; localStorage.setItem('psl_token', j.token);
      if (PSL.ws && PSL.ws.readyState === 1) PSL.ws.send(JSON.stringify({ type: 'auth', token: j.token }));
    }
    return j;
  };
  PSL.logout = async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + PSL.token } }); } catch {}
    PSL.token = null; localStorage.removeItem('psl_token');
    if (PSL.ws && PSL.ws.readyState === 1) PSL.ws.send(JSON.stringify({ type: 'auth', token: null }));
  };

  // ------------------------------------------------------------ sound (WebAudio, no files)
  let actx = null;
  PSL.muted = localStorage.getItem('psl_muted') === '1';
  PSL.setMuted = (m) => { PSL.muted = m; localStorage.setItem('psl_muted', m ? '1' : '0'); };
  const tone = (f, d, type = 'sine', vol = 0.12, delay = 0, slide = 0) => {
    if (PSL.muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const o = actx.createOscillator(), g = actx.createGain();
      const t = actx.currentTime + delay;
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + d);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d + 0.05);
    } catch {}
  };
  PSL.sfx = {
    bid: () => { tone(660, 0.09, 'triangle', 0.1); tone(990, 0.12, 'triangle', 0.09, 0.07); },
    next: () => { tone(300, 0.25, 'sawtooth', 0.05, 0, 500); tone(520, 0.2, 'triangle', 0.08, 0.12); },
    sold: () => { tone(140, 0.18, 'square', 0.18); tone(110, 0.3, 'square', 0.16, 0.16); [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.28, 'triangle', 0.1, 0.45 + i * 0.1)); },
    unsold: () => { tone(300, 0.3, 'sawtooth', 0.08, 0, -150); tone(200, 0.4, 'sawtooth', 0.08, 0.25, -90); },
    tick: () => tone(880, 0.05, 'square', 0.05),
    going: () => tone(420, 0.2, 'triangle', 0.09),
  };

  // simple confetti on a canvas
  PSL.confetti = (canvas, colors) => {
    const ctx = canvas.getContext('2d');
    const w = (canvas.width = canvas.offsetWidth), h = (canvas.height = canvas.offsetHeight);
    const parts = Array.from({ length: 140 }, () => ({
      x: w / 2 + (Math.random() - 0.5) * 120, y: h * 0.42, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
      s: 5 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    let f = 0;
    (function tick() {
      ctx.clearRect(0, 0, w, h);
      parts.forEach((p) => { p.vy += 0.38; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vx *= 0.99; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); });
      if (++f < 150) requestAnimationFrame(tick); else ctx.clearRect(0, 0, w, h);
    })();
  };

  PSL.fmtDate = (s) => {
    if (!s) return '';
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  };
})();
