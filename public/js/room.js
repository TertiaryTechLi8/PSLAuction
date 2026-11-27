/* Live auction room: player spotlight, timer, bidding, host controls */
(function () {
  const { $, $$, esc, on } = PSL;
  const C = 2 * Math.PI * 52;
  let R = null; // room runtime

  const roleChip = (r) => `<span class="role r-${esc((r || '').replace(/[^A-Za-z]/g, '').toLowerCase())}">${esc(r || '')}</span>`;
  const catChip = (c) => (c ? `<span class="cat c-${esc(c.toLowerCase())}">${esc(c)}</span>` : '');

  function remainingMs() {
    const a = PSL.state.auction;
    if (a.status === 'live') return Math.max(0, a.timerEndsAt - PSL.now());
    if (a.status === 'paused') return a.remainingMs;
    return 0;
  }

  function cantBid(team, amount) {
    const a = PSL.state.auction, S = PSL.state.settings, p = PSL.player(a.playerId);
    if (a.status === 'paused') return 'Paused by the host';
    if (a.status !== 'live' || !p) return 'Waiting for the next player';
    if (remainingMs() <= 0) return a.timeUp ? 'Time is up. The host will decide.' : 'Time is up';
    if (a.leaderTeamId === team.id) return 'You hold the highest bid';
    if (a.passed.includes(team.id)) return 'You passed on this player';
    if (team.count >= S.maxSquad) return `Squad is full (${S.maxSquad})`;
    if (p.country !== 'pk' && team.overseas >= S.maxOverseas) return `Overseas limit reached (${S.maxOverseas})`;
    if (amount > team.remaining) return 'Not enough purse for this bid';
    if (amount > team.maxBid) return 'You must keep purse for your minimum squad';
    return null;
  }

  PSL.room = {
    mount(container) {
      R = { root: container, seq: null, lotKey: '', timer: null, lastGoing: '', lastSecTick: -1, proxyTeam: '', ovlTimer: null, busy: false };
      container.innerHTML = `
        <div class="room">
          <div class="room-top">
            <div class="rt-l"><span class="lotno" id="lotno"></span><span class="rstatus" id="rstatus"></span></div>
            <div class="rt-r"><span class="mut small" id="online"></span><button class="btn ghost sm" id="snd" aria-label="Toggle sound"></button></div>
          </div>
          <div id="hbanner"></div>
          <div class="room-grid">
            <section class="stage" id="stage">
              <div class="spot" id="spot"></div>
              <div class="bidbox">
                <div class="cur" id="cur"></div>
                <div class="ring" id="ring"><svg viewBox="0 0 120 120"><circle class="rg-bg" cx="60" cy="60" r="52"/><circle class="rg-fg" id="rfg" cx="60" cy="60" r="52" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg><div class="rnum"><b id="rsec">0</b><small>sec</small></div></div>
              </div>
              <div class="going" id="going" aria-live="polite"></div>
              <ul class="hist" id="hist"></ul>
              <div class="ovl" id="ovl" hidden><canvas id="cnv"></canvas><div class="ovl-in" id="ovlin"></div></div>
            </section>
            <aside class="side">
              <div class="panel" id="ctl"></div>
              <div class="panel" id="teams"></div>
            </aside>
          </div>
          <section class="room-bottom"><div class="panel" id="upnext"></div><div class="panel" id="results"></div></section>
        </div>`;
      const root = container;
      $('#snd', root).onclick = () => { PSL.setMuted(!PSL.muted); this.sound(); if (!PSL.muted) PSL.sfx.bid(); };
      this.sound();
      // delegated actions
      on(root, 'click', '[data-a]', (e, b) => this.act(b));
      on(root, 'change', '#proxyteam', (e, s) => (R.proxyTeam = s.value));
      R.key = (e) => {
        if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
        const k = e.key.toLowerCase();
        if (PSL.isHost()) {
          if (k === 'n') { e.preventDefault(); this.host('auctionNext'); }
          else if (k === ' ') { e.preventDefault(); this.host(PSL.state.auction.status === 'paused' ? 'auctionResume' : 'auctionPause'); }
          else if (k === 's') this.host('auctionSold');
          else if (k === 'u') this.host('auctionUnsold');
        } else if (k === 'b' || (k === ' ' && document.activeElement === document.body)) { e.preventDefault(); this.bid(1); }
      };
      document.addEventListener('keydown', R.key);
      R.timer = setInterval(() => this.tick(), 100);
      R.unsub = PSL.subscribe((info) => { if (R) this.render(); });
      this.render(true);
    },
    unmount() {
      if (!R) return;
      clearInterval(R.timer); document.removeEventListener('keydown', R.key); if (R.unsub) R.unsub();
      R = null;
    },
    sound() { const b = $('#snd', R.root); if (b) b.innerHTML = PSL.muted ? 'Sound off' : 'Sound on'; },

    // ---------------------------------------------------------- actions
    async host(action, body) {
      const r = await PSL.host(action, body || {});
      if (!r.ok) PSL.toast(r.error || 'Failed', 'bad');
      return r;
    },
    async bid(steps) {
      if (R.busy) return; R.busy = true; setTimeout(() => (R.busy = false), 250);
      const a = PSL.state.auction;
      const expect = steps > 1 ? a.currentBid + steps * a.inc : a.nextAmount;
      const r = await PSL.send({ type: 'bid', steps, expect });
      if (!r.ok) { PSL.toast(r.error || 'Bid failed', 'bad'); }
    },
    async act(b) {
      const a = b.dataset.a;
      if (a === 'bid') return this.bid(1);
      if (a === 'golden') return this.bid(Number(b.dataset.steps));
      if (a === 'pass') { const r = await PSL.send({ type: 'pass' }); if (!r.ok) PSL.toast(r.error, 'bad'); return; }
      if (a === 'login') return PSL.showLogin();
      if (a === 'proxy') { const t = $('#proxyteam', R.root).value; if (!t) return PSL.toast('Choose a team first', 'bad'); return this.host('auctionProxyBid', { teamId: t }); }
      if (a === 'play') return this.host('auctionStart', { playerId: b.dataset.id });
      if (a === 'openwatch') { const r = await this.host('settings', { auctionMode: 'watch' }); if (r.ok) PSL.toast('Auction is now open to everyone', 'ok'); return; }
      if (a === 'savequick') {
        const t = Number($('#qt', R.root).value), br = Number($('#qr', R.root).value), af = $('#qa', R.root).checked;
        const r = await this.host('settings', { timerSeconds: t, bidResetSeconds: br, autoFinalize: af });
        if (r.ok) PSL.toast('Timer settings saved', 'ok');
        return;
      }
      if (a === 'addtime') return this.host('auctionAddTime', { seconds: 10 });
      const map = { next: 'auctionNext', pause: 'auctionPause', resume: 'auctionResume', restart: 'auctionRestartTimer', sold: 'auctionSold', unsold: 'auctionUnsold', undo: 'auctionUndoBid', release: 'auctionRelease' };
      if (map[a]) return this.host(map[a]);
    },

    // ---------------------------------------------------------- rendering
    render(first) {
      if (!R || !PSL.state.settings) return;
      const A = PSL.state.auction;
      this.renderTop(); this.renderSpot(); this.renderBid(); this.renderHist(); this.renderControls(); this.renderTeams(); this.renderBottom();
      if (R.seq === null) R.seq = A.event.seq;
      else if (A.event.seq !== R.seq) { R.seq = A.event.seq; this.fx(A.event); }
      this.tick(true);
    },
    renderTop() {
      const A = PSL.state.auction, S = PSL.state.settings;
      $('#lotno', R.root).innerHTML = A.lotNo ? `Lot <b>${A.lotNo}</b>` : 'Auction room';
      const label = { idle: 'Waiting for next player', live: 'Bidding open', paused: 'Paused', sold: 'Sold', unsold: 'Unsold' }[A.status];
      const st = $('#rstatus', R.root); st.textContent = label; st.className = 'rstatus s-' + A.status;
      const on = PSL.state.online;
      $('#online', R.root).textContent = `${on.users.length} team owner${on.users.length === 1 ? '' : 's'} online, ${on.visitors} watching`;
      const hb = $('#hbanner', R.root);
      if (PSL.isHost() && S.auctionMode !== 'watch') {
        const nm = { coming_soon: 'Coming soon', register: 'Register yourself' }[S.auctionMode];
        hb.innerHTML = `<div class="banner"><span>Visitors and your friends currently see the <b>${nm}</b> page, not this room.</span><button class="btn sm" data-a="openwatch">Open auction to everyone</button></div>`;
      } else hb.innerHTML = '';
    },
    renderSpot() {
      const A = PSL.state.auction, p = PSL.player(A.playerId);
      const key = A.lotNo + ':' + A.playerId + ':' + A.status + ':' + (p ? p.name + p.country + p.basePrice : '');
      if (key === R.lotKey) return;
      const newLot = !R.lotKey.startsWith(A.lotNo + ':' + A.playerId + ':');
      R.lotKey = key;
      const spot = $('#spot', R.root);
      if (!p) {
        spot.className = 'spot idle';
        spot.innerHTML = `<div class="idle-in"><div class="pulse-ring"></div><h2>Next player coming up</h2><p>${PSL.isHost() ? 'Press Next player to bring the first name to the block.' : 'The host will bring the next player to the block shortly.'}</p></div>`;
        return;
      }
      const st = A.status === 'sold' ? `<div class="stamp sold">SOLD</div>` : A.status === 'unsold' ? `<div class="stamp unsold">UNSOLD</div>` : '';
      spot.className = 'spot' + (newLot ? ' enter' : '');
      spot.innerHTML = `${st}
        <div class="spot-flag">${PSL.flag(p.country, 'xl')}</div>
        <div class="spot-main">
          <h2 class="pname">${esc(p.name)}</h2>
          <div class="pmeta"><span class="pc">${esc(PSL.countryName(p.country))}</span>${roleChip(p.role)}${catChip(p.category)}${p.country !== 'pk' ? '<span class="role r-os">Overseas</span>' : ''}</div>
        </div>
        <div class="spot-base"><small>Base price</small><b>${PSL.cr(p.basePrice)}<i>Cr</i></b></div>`;
    },
    renderBid() {
      const A = PSL.state.auction, p = PSL.player(A.playerId);
      const el = $('#cur', R.root);
      const lead = PSL.team(A.leaderTeamId);
      const amount = A.currentBid || (p ? p.basePrice : 0);
      const sig = amount + ':' + (lead ? lead.id : '') + ':' + A.status;
      if (sig === R.bidSig) return;
      const grew = R.bidSig && !R.bidSig.startsWith(amount + ':');
      R.bidSig = sig;
      let who;
      if (A.status === 'sold' && A.result) { const t = PSL.team(A.result.teamId); who = `<div class="lead sold" style="--tc:${esc(t.color)}">${PSL.badge(t, 'md')}<div><small>Sold to</small><b>${esc(t.name)}</b></div></div>`; }
      else if (A.status === 'unsold') who = `<div class="lead none"><div><small>Result</small><b>No bids, unsold</b></div></div>`;
      else if (lead) who = `<div class="lead" style="--tc:${esc(lead.color)}">${PSL.badge(lead, 'md')}<div><small>Highest bidder</small><b>${esc(lead.name)}</b></div></div>`;
      else who = `<div class="lead none"><div><small>${p ? 'Opening bid' : ''}</small><b>${p ? 'Waiting for the first bid' : 'No player on the block'}</b></div></div>`;
      el.innerHTML = `<small class="cl">${A.currentBid || A.status === 'sold' ? 'Current bid' : 'Base price'}</small><div class="amt ${grew ? 'pop' : ''}"><b>${p ? PSL.cr(amount) : '0.00'}</b><i>Cr</i></div>${who}`;
    },
    renderHist() {
      const A = PSL.state.auction;
      const rows = [...A.history].reverse().slice(0, 6);
      const key = rows.map((h) => h.at).join();
      if (key === R.histKey) return; R.histKey = key;
      $('#hist', R.root).innerHTML = rows.map((h, i) => { const t = PSL.team(h.teamId); return `<li class="${i === 0 ? 'new' : ''}" style="--tc:${esc(t.color)}">${PSL.badge(t, 'xs')}<b>${esc(t.short)}</b><span>${PSL.money(h.amount)}</span>${h.golden ? '<em>Golden Paddle</em>' : ''}</li>`; }).join('');
    },
    renderControls() {
      const A = PSL.state.auction, S = PSL.state.settings, me = PSL.state.me, el = $('#ctl', R.root);
      const running = ['live', 'paused'].includes(A.status);
      let html;
      if (PSL.isHost()) {
        const teams = PSL.state.teams;
        html = `
          <h3>Host controls</h3>
          <button class="btn big full next" data-a="next" ${running ? 'disabled' : ''}>Next player <kbd>N</kbd></button>
          ${A.timeUp && running ? '<div class="note warn">Time is up. Choose Sold or Unsold.</div>' : ''}
          <div class="hgrid">
            ${A.status === 'paused' ? `<button class="btn" data-a="resume">Resume <kbd>Space</kbd></button>` : `<button class="btn ghost" data-a="pause" ${A.status !== 'live' ? 'disabled' : ''}>Pause <kbd>Space</kbd></button>`}
            <button class="btn ghost" data-a="addtime" ${running ? '' : 'disabled'}>+10 sec</button>
            <button class="btn ghost" data-a="restart" ${running ? '' : 'disabled'}>Restart timer</button>
            <button class="btn ok" data-a="sold" ${running && A.leaderTeamId ? '' : 'disabled'}>Sold <kbd>S</kbd></button>
            <button class="btn danger" data-a="unsold" ${running ? '' : 'disabled'}>Unsold <kbd>U</kbd></button>
            <button class="btn ghost" data-a="undo" ${running && A.history.length ? '' : 'disabled'}>Undo last bid</button>
            <button class="btn ghost" data-a="release" ${running && !A.history.length ? '' : 'disabled'}>Back to queue</button>
          </div>
          <div class="proxy"><label>Bid for a team (in case someone is offline)<select id="proxyteam"><option value="">Choose team</option>${teams.map((t) => `<option value="${t.id}" ${R.proxyTeam === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label><button class="btn ghost" data-a="proxy" ${A.status === 'live' ? '' : 'disabled'}>Place bid</button></div>
          <details class="quick"><summary>Timer settings</summary>
            <div class="qgrid"><label>Seconds per player<input id="qt" type="number" min="5" max="600" value="${S.timerSeconds}"></label><label>Reset to at least (sec) after a bid<input id="qr" type="number" min="0" max="120" value="${S.bidResetSeconds}"></label></div>
            <label class="chk"><input id="qa" type="checkbox" ${S.autoFinalize ? 'checked' : ''}> Sell automatically when the timer ends</label>
            <button class="btn sm" data-a="savequick">Save timer settings</button></details>`;
      } else if (me && me.role === 'bidder') {
        const team = PSL.myTeam();
        const p = PSL.player(A.playerId);
        const amt = A.nextAmount;
        const reason = team ? cantBid(team, amt) : 'No team assigned to you';
        const canPass = A.status === 'live' && team && A.leaderTeamId !== team.id && !A.passed.includes(team.id);
        const golden = team && A.currentBid && team.paddlesLeft > 0 ? [2, 3, 5] : [];
        html = `
          <div class="myteam" style="--tc:${esc(team ? team.color : '#888')}">${PSL.badge(team, 'md')}<div><b>${esc(team ? team.name : '')}</b><small>Max bid ${team ? PSL.money(team.maxBid) : ''}</small></div></div>
          <button class="bidbtn" data-a="bid" ${reason ? 'disabled' : ''}><span>${reason ? 'Bid' : 'Bid now'}</span><b>${p ? PSL.money(amt) : '-'}</b></button>
          <div class="reason ${reason ? 'on' : ''}">${reason ? esc(reason) : 'Press B or tap to bid'}</div>
          ${S.goldenPaddles > 0 ? `<div class="paddle"><div><b>Golden Paddle</b><small>${team ? team.paddlesLeft : 0} of ${S.goldenPaddles} left. Jump the bid in bigger steps.</small></div><div class="pbtns">${[2, 3, 5].map((k) => { const v = A.currentBid + k * A.inc; const dis = !golden.length || !!(team && cantBid(team, v)); return `<button class="btn gold sm" data-a="golden" data-steps="${k}" ${dis ? 'disabled' : ''}>${PSL.cr(v)}</button>`; }).join('')}</div></div>` : ''}
          <button class="btn ghost full" data-a="pass" ${canPass ? '' : 'disabled'}>Pass on this player</button>`;
      } else {
        html = `<h3>You are watching</h3><p class="mut">Team owners log in to place bids from their own device.</p><button class="btn full" data-a="login">${me ? 'Switch account' : 'Log in to bid'}</button>`;
      }
      // avoid rebuilding while the host is typing in the timer settings
      const typing = el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
      const open = el.querySelector('details') && el.querySelector('details').open;
      if (typing) return;
      el.innerHTML = html;
      if (open) { const d = el.querySelector('details'); if (d) d.open = true; }
    },
    renderTeams() {
      const A = PSL.state.auction, me = PSL.state.me, online = new Set(PSL.state.online.users);
      const rows = PSL.state.teams.map((t) => {
        const lead = A.leaderTeamId === t.id && ['live', 'paused'].includes(A.status);
        const passed = A.passed.includes(t.id);
        const mine = me && me.teamId === t.id;
        return `<li class="trow ${lead ? 'lead' : ''} ${passed ? 'passed' : ''} ${mine ? 'mine' : ''}" data-t="${t.id}" style="--tc:${esc(t.color)}">
          ${PSL.badge(t, 'sm')}<div class="tn"><b>${esc(t.short)}${mine ? ' <em>You</em>' : ''}${lead ? ' <span class="tag lead">Leading</span>' : passed ? ' <span class="tag pass">Passed</span>' : ''}</b><small>${esc(t.owner || 'No owner')}${t.ownerId && online.has(t.ownerId) ? ' <i class="on"></i>' : ''}</small></div>
          <div class="tm"><b>${PSL.cr(t.remaining)}<i>Cr</i></b><small>${t.count} players, ${t.overseas} overseas</small></div></li>`;
      }).join('');
      $('#teams', R.root).innerHTML = `<h3>Teams and purses</h3><ul class="trows">${rows}</ul>`;
    },
    renderBottom() {
      const A = PSL.state.auction, host = PSL.isHost();
      const up = A.upcoming.map((id) => PSL.player(id)).filter(Boolean);
      $('#upnext', R.root).innerHTML = `<h3>Up next <span class="mut">${A.queueLeft} in the queue</span></h3><ul class="ulist">${up.map((p) => `<li>${PSL.flag(p.country)}<div><b>${esc(p.name)}</b><small>${esc(PSL.countryName(p.country))}</small></div><span class="gold">${PSL.money(p.basePrice)}</span>${host ? `<button class="btn ghost sm" data-a="play" data-id="${p.id}" ${['live', 'paused'].includes(A.status) ? 'disabled' : ''}>Play now</button>` : ''}</li>`).join('') || '<li class="empty">Queue is empty</li>'}</ul>`;
      const log = [...A.log].reverse().slice(0, 12);
      $('#results', R.root).innerHTML = `<h3>Sold board</h3><ul class="ulist">${log.map((l) => { const p = PSL.player(l.playerId), t = PSL.team(l.teamId); return `<li>${PSL.flag(p ? p.country : '')}<div><b>${esc(p ? p.name : '?')}</b><small>${l.type === 'sold' && t ? 'Sold to ' + esc(t.name) : 'Unsold'}</small></div>${l.type === 'sold' ? `<span class="gold">${PSL.money(l.price)}</span>` : '<span class="mut">-</span>'}</li>`; }).join('') || '<li class="empty">No lots finished yet</li>'}</ul>`;
    },

    // ---------------------------------------------------------- live timer + going once/twice
    tick(force) {
      if (!R) return;
      const A = PSL.state.auction; if (!A) return;
      const rem = remainingMs();
      const fg = $('#rfg', R.root), sec = $('#rsec', R.root), ring = $('#ring', R.root);
      if (!fg) return;
      const frac = A.durationMs ? Math.min(1, rem / A.durationMs) : 0;
      fg.style.strokeDashoffset = C * (1 - frac);
      const s = Math.ceil(rem / 1000);
      sec.textContent = ['live', 'paused'].includes(A.status) ? s : '-';
      ring.className = 'ring' + (A.status === 'paused' ? ' paused' : rem <= 5000 && A.status === 'live' ? ' hot' : rem <= 10000 && A.status === 'live' ? ' warm' : '');
      let g = '';
      if (A.status === 'paused') g = 'Paused';
      else if (A.status === 'live') {
        if (rem <= 0) g = A.timeUp ? 'Time is up' : 'Closing';
        else if (A.leaderTeamId && rem <= 3000) g = 'Going twice...';
        else if (A.leaderTeamId && rem <= 6000) g = 'Going once...';
        else if (!A.leaderTeamId && rem <= 5000) g = 'Last call';
      }
      const ge = $('#going', R.root);
      if (g !== R.lastGoing) { R.lastGoing = g; ge.textContent = g; ge.className = 'going' + (g ? ' on' : ''); if (g.startsWith('Going')) PSL.sfx.going(); }
      if (A.status === 'live' && s !== R.lastSecTick) { R.lastSecTick = s; if (s <= 5 && s > 0) PSL.sfx.tick(); }
    },

    // ---------------------------------------------------------- event effects
    fx(ev) {
      const stage = $('#stage', R.root);
      if (ev.type === 'bid') {
        PSL.sfx.bid();
        const row = $(`.trow[data-t="${ev.teamId}"]`, R.root); if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
        const amt = $('#cur .amt', R.root); if (amt) { amt.classList.remove('pop'); void amt.offsetWidth; amt.classList.add('pop'); }
        stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake');
        const t = PSL.team(ev.teamId); stage.style.setProperty('--lead', t ? t.color : '#4ade9d');
      } else if (ev.type === 'next') PSL.sfx.next();
      else if (ev.type === 'sold') this.overlay('sold', ev);
      else if (ev.type === 'unsold') this.overlay('unsold', ev);
      else if (ev.type === 'timeup' && PSL.isHost()) PSL.toast('Time is up. Choose Sold or Unsold.', 'bad');
      else if (ev.type === 'pause') PSL.toast('Auction paused');
      else if (ev.type === 'resume') PSL.toast('Auction resumed', 'ok');
    },
    overlay(kind, ev) {
      const o = $('#ovl', R.root), inn = $('#ovlin', R.root);
      const p = PSL.player(ev.playerId), t = PSL.team(ev.teamId);
      clearTimeout(R.ovlTimer);
      if (kind === 'sold' && t) {
        PSL.sfx.sold();
        inn.className = 'ovl-in sold'; inn.style.setProperty('--tc', t.color);
        inn.innerHTML = `<div class="gavel"><svg viewBox="0 0 64 64"><g class="gv"><rect x="8" y="10" width="30" height="16" rx="3" transform="rotate(-35 23 18)" fill="#e9b949"/><rect x="26" y="26" width="6" height="30" rx="3" transform="rotate(-35 29 41)" fill="#a8742b"/></g><rect x="36" y="52" width="24" height="6" rx="3" fill="#33466f"/></svg></div><h2>SOLD!</h2><div class="who">${PSL.badge(t, 'lg')}<b>${esc(t.name)}</b></div><p><span>${esc(p ? p.name : '')}</span> for <strong>${PSL.money(ev.price)}</strong></p>`;
      } else {
        PSL.sfx.unsold();
        inn.className = 'ovl-in unsold'; inn.style.removeProperty('--tc');
        inn.innerHTML = `<h2>UNSOLD</h2><p>${esc(p ? p.name : '')} finds no taker this time.</p>`;
      }
      o.hidden = false; o.classList.remove('show'); void o.offsetWidth; o.classList.add('show');
      if (kind === 'sold' && t) PSL.confetti($('#cnv', R.root), [t.color, '#e9b949', '#ffffff', '#4ade9d']);
      R.ovlTimer = setTimeout(() => { o.classList.remove('show'); setTimeout(() => (o.hidden = true), 400); }, 4200);
    },
  };
})();
