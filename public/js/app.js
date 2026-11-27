/* App shell: header, router, login, home (train journey), auction landing */
(function () {
  const { $, $$, esc, on } = PSL;
  PSL.views = PSL.views || {};
  let current = null;
  let currentName = null;
  const view = () => $('#view');

  const LOGO = `<img class="logo-img" src="/assets/psl-logo.png" alt="PSL" onerror="this.outerHTML='<span class=&quot;logo-fallback&quot;>PSL</span>'">`;

  // ------------------------------------------------------------ header
  function renderHeader() {
    const s = PSL.state;
    const me = s.me;
    const live = s.auction && ['live', 'paused'].includes(s.auction.status) && (s.settings.auctionMode === 'watch' || PSL.isHost());
    const links = [
      ['', 'Journey'], ['direct', 'Direct signings'], ['retention', 'Retentions'], ['players', 'Players'], ['squads', 'Squads'],
      ['auction', 'Auction' + (live ? '<i class="live-dot"></i>' : '')],
    ];
    if (PSL.isHost()) links.push(['host', 'Host console']);
    const hdr = $('#hdr');
    const team = PSL.myTeam();
    hdr.innerHTML = `
      <a class="brand" href="#/" aria-label="Home">${LOGO}
        <span class="brand-txt"><small>Tertiary Tech presents</small><b>PSL</b><em>Pakistan Superior League</em></span>
      </a>
      <nav class="nav" id="nav">${links.map(([h, l]) => `<a href="#/${h}" data-r="${h}">${l}</a>`).join('')}</nav>
      <div class="acct">
        ${me ? `<span class="chip">${team ? PSL.badge(team, 'xs') : ''}<span>${esc(me.displayName)}</span></span><button class="btn ghost sm" id="btn-logout">Log out</button>` : `<button class="btn sm" id="btn-login">Log in</button>`}
        <span class="conn ${PSL.connected ? 'ok' : 'bad'}" title="${PSL.connected ? 'Connected' : 'Reconnecting'}"></span>
      </div>`;
    markNav();
  }
  function markNav() {
    $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === (currentName === 'home' ? '' : currentName)));
  }
  document.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-login')) PSL.showLogin();
    if (e.target.closest('#btn-logout')) { await PSL.logout(); PSL.toast('Logged out'); }
  });

  PSL.showLogin = (after) => {
    const m = PSL.modal(`
      <h3>Log in</h3><p class="mut">Team owners use the username and password the host gave them.</p>
      <form id="lf" class="stack">
        <label>Username<input name="u" autocomplete="username" autocapitalize="none" required></label>
        <label>Password<input name="p" type="password" autocomplete="current-password" required></label>
        <div class="err" id="lerr"></div>
        <div class="row end gap"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Log in</button></div>
      </form>`);
    const f = m.el.querySelector('#lf');
    f.u.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const r = await PSL.login(f.u.value, f.p.value);
      if (!r.ok) { m.el.querySelector('#lerr').textContent = r.error || 'Login failed'; return; }
      m.close(); PSL.toast('Welcome, ' + r.me.displayName, 'ok');
      if (r.me.role === 'host') location.hash = '#/host';
      if (after) after();
    };
  };

  // ------------------------------------------------------------ router
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [name0, ...rest] = h.split('/');
    let name = name0 || 'home';
    if (!PSL.views[name]) name = 'home';
    if (name === 'host' && !PSL.isHost()) {
      if (PSL.state.settings) { name = 'home'; if (!PSL.state.me) PSL.showLogin(); }
    }
    if (current && current.unmount) current.unmount();
    currentName = name;
    current = PSL.views[name];
    const root = view();
    root.className = 'view v-' + name;
    root.innerHTML = '';
    current.mount(root, rest);
    window.scrollTo({ top: 0 });
    markNav();
    root.classList.remove('enter'); void root.offsetWidth; root.classList.add('enter');
  }
  window.addEventListener('hashchange', route);

  let lastHdrSig = '';
  PSL.subscribe((info) => {
    if (!PSL.state.settings) return;
    const sig = JSON.stringify([PSL.state.me, PSL.connected, PSL.state.auction.status, PSL.state.settings.auctionMode]);
    if (sig !== lastHdrSig) { lastHdrSig = sig; renderHeader(); }
    if (info.firstState) return route();
    if (current && current.update) current.update(info);
    if (currentName === 'host' && !PSL.isHost()) location.hash = '#/';
  });

  // ------------------------------------------------------------ helpers shared by views
  PSL.stats = () => {
    const p = PSL.state.players;
    const sum = (st) => p.filter((x) => x.status === st).reduce((a, x) => a + x.price, 0);
    return {
      direct: p.filter((x) => x.status === 'direct'), retained: p.filter((x) => x.status === 'retained'),
      directSum: sum('direct'), retainSum: sum('retained'),
      pool: p.filter((x) => x.status === 'pool').length, sold: p.filter((x) => x.status === 'sold').length, unsold: p.filter((x) => x.status === 'unsold').length,
    };
  };

  // ------------------------------------------------------------ home: the road to auction
  const STAGE_IDX = { direct: 0, retention: 1, auction: 2 };
  const STOP_X = [0.17, 0.5, 0.83];

  const TRAIN_SVG = `
  <svg class="train-svg" viewBox="0 0 480 138" aria-hidden="true">
    <defs>
      <radialGradient id="hl" cx="0" cy="0.5" r="1"><stop offset="0" stop-color="#fff6c8" stop-opacity=".95"/><stop offset="1" stop-color="#fff6c8" stop-opacity="0"/></radialGradient>
      <linearGradient id="liv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17a36f"/><stop offset="1" stop-color="#0b6a47"/></linearGradient>
    </defs>
    <g class="steam"><circle cx="428" cy="24" r="7"/><circle cx="428" cy="24" r="7"/><circle cx="428" cy="24" r="7"/></g>
    <!-- carriage 1 -->
    <g>
      <rect x="4" y="30" width="140" height="66" rx="9" fill="url(#liv)"/>
      <rect x="4" y="70" width="140" height="7" fill="#e9b949"/>
      ${[0, 1, 2, 3, 4].map((i) => `<rect class="win" x="${15 + i * 25}" y="40" width="17" height="21" rx="3" style="--d:${i * 0.18}s"/>`).join('')}
      <text x="74" y="90" text-anchor="middle" class="train-txt">TERTIARY TECH</text>
      ${[28, 118].map((x) => `<g class="wheel"><circle cx="${x}" cy="100" r="11" fill="#0a1224" stroke="#9aa8c4" stroke-width="2"/><path d="M${x - 9} 100h18M${x} 91v18" stroke="#9aa8c4" stroke-width="1.6"/></g>`).join('')}
    </g>
    <rect x="144" y="86" width="10" height="5" fill="#7b8aa8"/>
    <!-- carriage 2 -->
    <g transform="translate(154 0)">
      <rect x="4" y="30" width="140" height="66" rx="9" fill="url(#liv)"/>
      <rect x="4" y="70" width="140" height="7" fill="#e9b949"/>
      ${[0, 1, 2, 3, 4].map((i) => `<rect class="win" x="${15 + i * 25}" y="40" width="17" height="21" rx="3" style="--d:${i * 0.18 + 0.4}s"/>`).join('')}
      <text x="74" y="90" text-anchor="middle" class="train-txt">PSL EXPRESS</text>
      ${[28, 118].map((x) => `<g class="wheel"><circle cx="${x}" cy="100" r="11" fill="#0a1224" stroke="#9aa8c4" stroke-width="2"/><path d="M${x - 9} 100h18M${x} 91v18" stroke="#9aa8c4" stroke-width="1.6"/></g>`).join('')}
    </g>
    <rect x="298" y="86" width="10" height="5" fill="#7b8aa8"/>
    <!-- locomotive -->
    <g>
      <rect x="338" y="44" width="112" height="46" rx="20" fill="url(#liv)"/>
      <rect x="338" y="72" width="112" height="6" fill="#e9b949"/>
      <rect x="306" y="30" width="58" height="66" rx="7" fill="#0f7e55"/>
      <rect x="300" y="23" width="70" height="10" rx="4" fill="#e9b949"/>
      <rect class="win" x="316" y="40" width="30" height="22" rx="3"/>
      <path d="M418 44v-20h20l-4 8h-12v12z" fill="#0a1224"/>
      <rect x="412" y="20" width="32" height="7" rx="3" fill="#e9b949"/>
      <ellipse cx="392" cy="43" rx="9" ry="6" fill="#e9b949"/>
      <circle cx="451" cy="62" r="6" fill="#fff6c8"/>
      <path d="M455 62l70-26v52z" fill="url(#hl)" class="beam-train"/>
      <path d="M448 92l26 14H436z" fill="#7b8aa8"/>
      <rect x="320" y="96" width="132" height="6" rx="3" fill="#0a1224"/>
      ${[[334, 14], [376, 14], [420, 12]].map(([x, r]) => `<g class="wheel"><circle cx="${x}" cy="102" r="${r}" fill="#0a1224" stroke="#e9b949" stroke-width="2.4"/><path d="M${x - r + 3} 102h${2 * r - 6}M${x} ${102 - r + 3}v${2 * r - 6}" stroke="#e9b949" stroke-width="1.8"/></g>`).join('')}
    </g>
  </svg>`;

  const STADIUM_SVG = `
  <svg class="stadium-svg" viewBox="0 0 320 170" aria-hidden="true">
    <defs><linearGradient id="bowl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22345c"/><stop offset="1" stop-color="#101b36"/></linearGradient></defs>
    <g class="tower"><rect x="14" y="26" width="5" height="120" fill="#33466f"/><rect x="2" y="14" width="30" height="22" rx="3" fill="#1c2c50"/>${[0, 1, 2, 3, 4, 5].map((i) => `<circle class="bulb" cx="${8 + (i % 3) * 9}" cy="${21 + Math.floor(i / 3) * 10}" r="3"/>`).join('')}</g>
    <g class="tower"><rect x="301" y="26" width="5" height="120" fill="#33466f"/><rect x="288" y="14" width="30" height="22" rx="3" fill="#1c2c50"/>${[0, 1, 2, 3, 4, 5].map((i) => `<circle class="bulb" cx="${294 + (i % 3) * 9}" cy="${21 + Math.floor(i / 3) * 10}" r="3"/>`).join('')}</g>
    <path d="M34 146 C34 70 90 40 160 40 C230 40 286 70 286 146 Z" fill="url(#bowl)"/>
    <path d="M34 146 C34 70 90 40 160 40 C230 40 286 70 286 146" fill="none" stroke="#4b6199" stroke-width="2"/>
    ${[0, 1, 2, 3].map((i) => `<path d="M${50 + i * 9} 146 C${52 + i * 9} ${84 + i * 8} ${100 + i * 8} ${58 + i * 6} 160 ${58 + i * 6} C${220 - i * 8} ${58 + i * 6} ${268 - i * 9} ${84 + i * 8} ${270 - i * 9} 146" fill="none" stroke="#34497d" stroke-width="1.2"/>`).join('')}
    <ellipse cx="160" cy="132" rx="92" ry="22" fill="#0e5f40"/>
    <ellipse cx="160" cy="132" rx="92" ry="22" fill="none" stroke="#e9f6ee" stroke-opacity=".5" stroke-width="1.5"/>
    <rect x="146" y="124" width="28" height="15" rx="2" fill="#c9a96b" opacity=".85"/>
    <path d="M40 40 L24 28 M280 40 L296 28" stroke="#33466f" stroke-width="2"/>
    <polygon class="beam" points="19,36 120,140 40,146"/><polygon class="beam" points="303,36 200,140 280,146"/>
  </svg>`;

  PSL.views.home = {
    alive: false,
    mount(root) {
      const self = this;
      self.alive = true; self.curIdx = -1; self.curX = null; self.raf = 0; self.busy = false; self.started = false;
      root.innerHTML = `
        <section class="hero">
          <div class="hero-in">
            <div class="hero-logo">${LOGO}</div>
            <h1><span class="h1a">Tertiary Tech presents</span><span class="h1b">PSL</span><span class="h1c">(Pakistan Superior League)</span></h1>
            <p class="lede">Follow the road to the player auction. Every direct signing, every retention and every rupee left in each team's purse, until the train pulls into the stadium.</p>
          </div>
        </section>
        <section class="journey-wrap">
          <div class="journey" id="journey" aria-label="Road to auction">
            <div class="sky"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <div class="skyline"></div>
            <div class="stops" id="stops"></div>
            <div class="rail"><div class="rail-top"></div><div class="sleepers"></div></div>
            <div class="train" id="train">${TRAIN_SVG}</div>
          </div>
          <div class="journey-ctl"><button class="btn ghost sm" id="replay">Replay the journey</button></div>
        </section>
        <section class="auction-cta" id="cta"></section>
        <section class="strip">
          <h2>The eight franchises</h2>
          <div class="team-strip" id="tstrip"></div>
        </section>`;
      self.root = root;
      self.drawStops(); self.drawCta(); self.drawStrip();
      self.train = $('#train', root);
      self.measure();
      self.setX(-self.tw - 20);
      self.onResize = () => { self.measure(); if (!self.busy) self.setX(self.curIdx < 0 ? -self.tw - 20 : self.stopX(self.curIdx)); };
      window.addEventListener('resize', self.onResize);
      $('#replay', root).onclick = () => self.restart();
      self.io = new IntersectionObserver((en) => { if (en[0].isIntersecting && !self.started) { self.started = true; setTimeout(() => self.run(), 500); } }, { threshold: 0.35 });
      self.io.observe($('#journey', root));
      self.sig = self.signature();
    },
    unmount() { this.alive = false; cancelAnimationFrame(this.raf); window.removeEventListener('resize', this.onResize); if (this.io) this.io.disconnect(); },
    signature() {
      const s = PSL.state, st = PSL.stats();
      return JSON.stringify([s.settings.stage, s.settings.auctionMode, s.settings.auctionDate, st.direct.length, st.directSum, st.retained.length, st.retainSum, s.teams.map((t) => [t.name, t.remaining, t.color]), s.auction.status]);
    },
    update() {
      if (!this.alive) return;
      const sig = this.signature();
      if (sig === this.sig) return;
      this.sig = sig;
      this.drawStops(); this.drawCta(); this.drawStrip();
      if (this.started && !this.busy) this.run();
    },
    measure() { const j = $('#journey', this.root); this.W = j.clientWidth; this.tw = this.train.firstElementChild.getBoundingClientRect().width || 340; },
    stopX(i) { return this.W * STOP_X[i] - this.tw / 2; },
    setX(x) { this.curX = x; this.train.style.transform = `translate3d(${x}px,0,0)`; },
    drawStops() {
      const st = PSL.stats(), s = PSL.state.settings;
      const idx = STAGE_IDX[s.stage] ?? 0;
      const lit = (i) => (this.curIdx >= i ? 'lit' : '');
      const modeTxt = { coming_soon: 'Opening soon', register: 'Registrations open', watch: 'Open to watch' }[s.auctionMode];
      $('#stops', this.root).innerHTML = [
        { i: 0, href: '#/direct', title: 'Direct Signing', line: `${st.direct.length} signed`, sub: st.direct.length ? PSL.money(st.directSum) + ' off the purses' : 'No signings yet', art: `<svg viewBox="0 0 80 80"><rect x="14" y="10" width="46" height="60" rx="5" fill="#f3f6ff"/><path d="M24 26h26M24 36h26M24 46h14" stroke="#9aa8c4" stroke-width="3" stroke-linecap="round"/><path d="M42 62l22-26 6 5-22 26-9 3z" fill="#e9b949"/></svg>` },
        { i: 1, href: '#/retention', title: 'Retention', line: `${st.retained.length} retained`, sub: st.retained.length ? PSL.money(st.retainSum) + ' off the purses' : 'No retentions yet', art: `<svg viewBox="0 0 80 80"><path d="M40 8l26 10v20c0 17-11 29-26 34C25 67 14 55 14 38V18z" fill="#14a06a"/><path d="M28 40l9 9 17-19" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
        { i: 2, href: '#/auction', title: 'Gaddafi Stadium, Lahore', line: 'Auction day', sub: modeTxt, art: '' },
      ].map((o) => `
        <a class="stop ${lit(o.i)} ${o.i === 2 ? 'stadium' : ''} ${o.i > idx ? 'future' : ''}" href="${o.href}" style="left:${STOP_X[o.i] * 100}%">
          <div class="sign"><span class="lamp"></span>
            ${o.art ? `<div class="sign-art">${o.art}</div>` : ''}
            <div class="sign-t"><b>${o.title}</b><span>${o.line}</span><small>${o.sub}</small></div>
          </div>
          ${o.i === 2 ? STADIUM_SVG : '<span class="pole"></span>'}
        </a>`).join('');
    },
    drawCta() {
      const s = PSL.state.settings, a = PSL.state.auction;
      const live = ['live', 'paused'].includes(a.status);
      let html;
      if (s.auctionMode === 'watch') {
        html = `<div class="cta-card watch"><div><h2>${live ? 'The auction is live' : 'Watch the auction'}</h2><p>${live ? 'A player is on the block right now.' : 'Open the auction room to see every bid as it happens.'}</p></div><a class="btn big pulse" href="#/auction">${live ? '<i class="live-dot"></i>Watch live' : 'Watch auction'}</a></div>`;
      } else if (s.auctionMode === 'register') {
        html = `<div class="cta-card"><div><h2>Registrations are open</h2><p>Want a seat in the auction? Put your name down and the host will be in touch.</p></div><a class="btn big" href="#/auction">Register yourself</a></div>`;
      } else {
        html = `<div class="cta-card soon"><div><h2>Auction coming soon</h2><p>${s.auctionDate ? 'Planned for ' + esc(PSL.fmtDate(s.auctionDate)) + '.' : 'The train is still on its way. Check the signings and retentions while you wait.'}</p></div><a class="btn big ghost" href="#/auction">See the auction tab</a></div>`;
      }
      $('#cta', this.root).innerHTML = html;
    },
    drawStrip() {
      $('#tstrip', this.root).innerHTML = PSL.state.teams.map((t) => `
        <a class="tcard" href="#/squads/${t.id}" style="--tc:${esc(t.color)}">
          ${PSL.badge(t, 'md')}
          <div><b>${esc(t.name)}</b><span>${t.count} players</span></div>
          <div class="tp"><small>Purse left</small><b>${PSL.cr(t.remaining)}<i>Cr</i></b></div>
        </a>`).join('');
    },
    async run() {
      if (this.busy || !this.alive) return;
      const target = STAGE_IDX[PSL.state.settings.stage] ?? 0;
      this.busy = true;
      if (target < this.curIdx) {
        this.curIdx = -1; this.drawStops();
        await this.move(-this.tw - 30, 900);
      }
      while (this.alive && this.curIdx < target) {
        const next = this.curIdx + 1;
        await this.move(this.stopX(next), next === 0 && this.curIdx < 0 ? 3200 : 2800);
        if (!this.alive) break;
        this.curIdx = next;
        this.drawStops();
        this.train.classList.add('halt');
        await new Promise((r) => setTimeout(r, next < target ? 1300 : 600));
        this.train.classList.remove('halt');
      }
      this.busy = false;
      if (this.alive && (STAGE_IDX[PSL.state.settings.stage] ?? 0) !== this.curIdx) this.run();
    },
    move(x, ms) {
      return new Promise((res) => {
        const from = this.curX, t0 = performance.now();
        this.train.classList.add('moving');
        const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
        const step = (t) => {
          if (!this.alive) return res();
          const k = Math.min(1, (t - t0) / ms);
          this.setX(from + (x - from) * ease(k));
          if (k < 1) this.raf = requestAnimationFrame(step);
          else { this.train.classList.remove('moving'); res(); }
        };
        this.raf = requestAnimationFrame(step);
      });
    },
    async restart() {
      if (this.busy) return;
      this.busy = true;
      this.curIdx = -1; this.drawStops();
      await this.move(-this.tw - 30, 700);
      this.busy = false;
      this.run();
    },
  };

  // ------------------------------------------------------------ auction landing (coming soon / register / watch)
  PSL.views.auction = {
    mount(root) {
      this.root = root; this.mode = null; this.roomUp = false;
      this.render(true);
    },
    unmount() { if (this.roomUp) PSL.room.unmount(); this.roomUp = false; if (this.timer) clearInterval(this.timer); },
    update(info) { this.render(false); },
    render(force) {
      const s = PSL.state.settings; if (!s) return;
      const mode = PSL.isHost() ? 'watch' : s.auctionMode;
      const key = mode + (PSL.state.me ? PSL.state.me.id : '');
      if (!force && key === this.key) return;
      this.key = key;
      if (this.roomUp) { PSL.room.unmount(); this.roomUp = false; }
      if (this.timer) clearInterval(this.timer);
      const root = this.root;
      if (mode === 'watch') {
        root.innerHTML = '<div id="room-host"></div>';
        PSL.room.mount($('#room-host', root));
        this.roomUp = true;
      } else if (mode === 'register') this.renderRegister(root);
      else this.renderSoon(root);
    },
    renderSoon(root) {
      const s = PSL.state.settings;
      const me = PSL.state.me;
      root.innerHTML = `
        <section class="soon-stage">
          <div class="flood l"></div><div class="flood r"></div>
          <div class="soon-card">
            <div class="soon-ico">${LOGO}</div>
            <h1>Coming soon</h1>
            <p>The auction room opens when the host flips the switch. Until then, the road to the auction is open for everyone.</p>
            <div class="cd" id="cd" hidden></div>
            ${s.auctionDate ? `<p class="when">${esc(PSL.fmtDate(s.auctionDate))} at ${esc(s.venue)}</p>` : `<p class="when">${esc(s.venue)}</p>`}
            <div class="row gap center">
              <a class="btn" href="#/squads">See the squads</a>
              <a class="btn ghost" href="#/players">Browse players</a>
              ${me ? '' : '<button class="btn ghost" id="soon-login">Team owner? Log in</button>'}
            </div>
            ${me && me.role === 'bidder' ? `<p class="mut small">You are logged in as ${esc(me.displayName)}. Your bidding console appears here once the auction opens.</p>` : ''}
          </div>
        </section>`;
      const b = $('#soon-login', root); if (b) b.onclick = () => PSL.showLogin();
      const d = new Date(s.auctionDate);
      if (s.auctionDate && !isNaN(d)) {
        const cd = $('#cd', root); cd.hidden = false;
        const tick = () => {
          let diff = Math.max(0, d - Date.now());
          const day = Math.floor(diff / 864e5); diff -= day * 864e5;
          const hr = Math.floor(diff / 36e5); diff -= hr * 36e5;
          const mn = Math.floor(diff / 6e4); diff -= mn * 6e4;
          const sc = Math.floor(diff / 1e3);
          cd.innerHTML = [[day, 'days'], [hr, 'hours'], [mn, 'min'], [sc, 'sec']].map(([v, l]) => `<div><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`).join('');
        };
        tick(); this.timer = setInterval(tick, 1000);
      }
    },
    renderRegister(root) {
      const s = PSL.state.settings;
      root.innerHTML = `
        <section class="soon-stage">
          <div class="flood l"></div><div class="flood r"></div>
          <div class="soon-card reg">
            <h1>Register yourself</h1>
            <p>Take a seat at the auction table. Tell the host who you are and which franchise you fancy.</p>
            <form id="rf" class="stack left">
              <label>Your name<input name="name" required maxlength="60" autocomplete="name"></label>
              <label>Phone or email<input name="contact" maxlength="80"></label>
              <label>Team you would like<select name="team"><option value="">No preference</option>${PSL.state.teams.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></label>
              <label>Anything else<input name="note" maxlength="200" placeholder="Optional"></label>
              <div class="err" id="rerr"></div>
              <button class="btn big">Register</button>
            </form>
            <p class="when">${s.auctionDate ? esc(PSL.fmtDate(s.auctionDate)) + ' at ' : ''}${esc(s.venue)}</p>
          </div>
        </section>`;
      const f = $('#rf', root);
      f.onsubmit = async (e) => {
        e.preventDefault();
        const r = await (await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(f))) })).json();
        if (!r.ok) { $('#rerr', root).textContent = r.error; return; }
        $('.soon-card', root).innerHTML = `<div class="done-ck">&#10003;</div><h1>You are registered</h1><p>The host has your details. Keep an eye on this page for the auction room.</p><a class="btn" href="#/">Back to the journey</a>`;
      };
    },
  };

  // ------------------------------------------------------------ boot
  document.title = 'Tertiary Tech presents PSL (Pakistan Superior League)';
  PSL.connect();
  // spectator state arrives from the websocket; show a loader until then
  view().innerHTML = '<div class="loader"><i></i><i></i><i></i></div>';
  // keyboard: scroll-to-top on route handled in route()
})();
