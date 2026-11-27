/* Public tabs: direct signings, retentions, players, squads */
(function () {
  const { $, $$, esc, on } = PSL;

  const roleChip = (r) => `<span class="role r-${esc((r || '').replace(/[^A-Za-z]/g, '').toLowerCase())}">${esc(r || '')}</span>`;
  const catChip = (c) => (c ? `<span class="cat c-${esc(c.toLowerCase())}">${esc(c)}</span>` : '');
  const teamSig = () => JSON.stringify([PSL.state.teams.map((t) => [t.name, t.short, t.color, t.remaining, t.count, t.purseTotal, t.owner]), PSL.state.settings.pursePkr, PSL.state.settings.stage]);

  function pRow(p, { price = true } = {}) {
    return `<li class="prow"><span class="pf">${PSL.flag(p.country)}</span><div class="pn"><b>${esc(p.name)}</b><small>${esc(PSL.countryName(p.country))}</small></div>${roleChip(p.role)}${price ? `<span class="pp">${PSL.money(p.price)}</span>` : ''}</li>`;
  }

  // ------------------------------------------------------------ direct signings / retentions
  function signingsView(kind) {
    const isDirect = kind === 'direct';
    const status = isDirect ? 'direct' : 'retained';
    return {
      mount(root) { this.root = root; this.render(); this.sig = this.signature(); },
      unmount() {},
      signature() { return teamSig() + PSL.state.players.filter((p) => p.status === status).map((p) => p.id + p.price + p.teamId).join(); },
      update(info) { const s = this.signature(); if (s !== this.sig) { this.sig = s; this.render(); } },
      render() {
        const S = PSL.state.settings, teams = PSL.state.teams;
        const list = PSL.state.players.filter((p) => p.status === status);
        const total = list.reduce((a, p) => a + p.price, 0);
        const head = isDirect
          ? `<h1>Direct signings</h1><p class="lede">Before the auction, franchises can sign players straight from the market. Every signing comes off the team's purse of ${PSL.money(S.pursePkr)}, and a team that signs directly can stretch that purse by up to ${PSL.money(S.directExtension)}.</p>`
          : `<h1>Retentions</h1><p class="lede">Each franchise keeps a handful of players from its last squad. Their price is deducted from the purse, and what is left is what the team carries into the auction.</p>`;
        const rows = teams.map((t) => {
          const mine = list.filter((p) => p.teamId === t.id);
          const cost = isDirect ? t.directSpend : t.retainSpend;
          const afterDirect = t.purseTotal - t.directSpend;
          const afterRet = afterDirect - t.retainSpend;
          return { t, mine, cost, afterDirect, afterRet };
        });
        const table = isDirect
          ? `<table class="tbl"><thead><tr><th>Team</th><th>Signed</th><th class="n">Price</th><th class="n">Starting purse</th><th class="n">Top-up</th><th class="n">Purse remaining</th></tr></thead><tbody>${rows.map(({ t, mine, cost, afterDirect }) => `
            <tr><td><a class="tl" href="#/squads/${t.id}">${PSL.badge(t, 'xs')}<span>${esc(t.name)}</span></a></td>
            <td>${mine.length ? mine.map((p) => `<span class="inl">${PSL.flag(p.country)} ${esc(p.name)}</span>`).join('') : '<span class="mut">None yet</span>'}</td>
            <td class="n gold">${mine.length ? PSL.money(cost) : '-'}</td><td class="n">${PSL.money(S.pursePkr)}</td><td class="n">${t.extension ? '+' + PSL.money(t.extension) : '-'}</td>
            <td class="n strong">${PSL.money(afterDirect)}</td></tr>`).join('')}</tbody></table>`
          : `<table class="tbl"><thead><tr><th>Team</th><th>Retained</th><th class="n">Retention cost</th><th class="n">Purse after direct signing</th><th class="n">Total purse remaining</th></tr></thead><tbody>${rows.map(({ t, mine, cost, afterDirect, afterRet }) => `
            <tr><td><a class="tl" href="#/squads/${t.id}">${PSL.badge(t, 'xs')}<span>${esc(t.name)}</span></a></td>
            <td>${mine.length ? `${mine.length} player${mine.length > 1 ? 's' : ''}` : '<span class="mut">None yet</span>'}</td>
            <td class="n gold">${mine.length ? PSL.money(cost) : '-'}</td><td class="n">${PSL.money(afterDirect)}</td><td class="n strong">${PSL.money(afterRet)}</td></tr>`).join('')}</tbody></table>`;
        const cards = rows.map(({ t, mine, cost, afterDirect, afterRet }) => {
          const pct = Math.min(100, Math.max(0, ((t.purseTotal - (isDirect ? afterDirect : afterRet)) / t.purseTotal) * 100));
          return `<article class="tcard2" style="--tc:${esc(t.color)}">
            <header>${PSL.badge(t, 'md')}<div><h3>${esc(t.name)}</h3><small>${mine.length} ${isDirect ? 'direct signing' : 'retention'}${mine.length === 1 ? '' : 's'}</small></div></header>
            <ul class="plist">${mine.length ? mine.map((p) => pRow(p)).join('') : `<li class="empty">${isDirect ? 'No direct signing yet' : 'No retentions yet'}</li>`}</ul>
            <div class="meter"><i style="width:${pct}%"></i></div>
            <footer><div><small>Deducted</small><b>${PSL.money(cost)}</b></div><div class="r"><small>Purse remaining</small><b>${PSL.money(isDirect ? afterDirect : afterRet)}</b></div></footer>
          </article>`;
        }).join('');
        this.root.innerHTML = `<section class="page-head">${head}<div class="kpis"><div><b>${list.length}</b><span>${isDirect ? 'signed directly' : 'players retained'}</span></div><div><b>${PSL.cr(total)}<i>Cr</i></b><span>deducted in total</span></div><div><b>${teams.filter((t) => list.some((p) => p.teamId === t.id)).length}/${teams.length}</b><span>teams done</span></div></div></section>
          <section class="card-wide scroll-x">${table}</section>
          <section class="grid-teams">${cards}</section>`;
      },
    };
  }
  PSL.views.direct = signingsView('direct');
  PSL.views.retention = signingsView('retention');

  // ------------------------------------------------------------ players registered for the auction
  PSL.views.players = {
    f: { q: '', country: '', category: '', role: '', status: 'auction', sort: 'order', dir: 1, limit: 120 },
    mount(root) {
      this.root = root;
      const f = this.f;
      root.innerHTML = `
        <section class="page-head"><h1>Players to be auctioned</h1>
          <p class="lede">Everyone registered for the auction, with country and base price. Sold and unsold players stay on the list so you can follow the night.</p>
          <div class="kpis" id="pk"></div></section>
        <section class="filters">
          <input id="pq" type="search" placeholder="Search by player name" value="${esc(f.q)}" aria-label="Search players">
          <select id="pc" aria-label="Country"></select>
          <select id="pcat" aria-label="Category"><option value="">All categories</option>${['Platinum', 'Diamond', 'Gold', 'Silver', 'Emerging'].map((c) => `<option ${f.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          <select id="pr" aria-label="Role"><option value="">All roles</option>${['Batter', 'Bowler', 'All-rounder', 'WK-Batter'].map((c) => `<option ${f.role === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          <select id="ps" aria-label="Status">${[['auction', 'To be auctioned'], ['sold', 'Sold'], ['unsold', 'Unsold'], ['signed', 'Direct and retained'], ['all', 'Everyone']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </section>
        <section class="card-wide scroll-x"><table class="tbl players"><thead><tr><th class="sortable" data-s="order">#</th><th class="sortable" data-s="name">Player</th><th class="sortable" data-s="country">Country</th><th>Role</th><th>Category</th><th class="n sortable" data-s="price">Base price</th><th>Status</th></tr></thead><tbody id="pb"></tbody></table>
          <div class="more" id="pmore"></div></section>`;
      const upd = () => { f.q = $('#pq', root).value; f.country = $('#pc', root).value; f.category = $('#pcat', root).value; f.role = $('#pr', root).value; f.status = $('#ps', root).value; f.limit = 120; this.rows(); };
      ['#pq', '#pc', '#pcat', '#pr', '#ps'].forEach((s) => ($(s, root).oninput = upd));
      on(root, 'click', 'th.sortable', (e, th) => { const k = th.dataset.s; if (f.sort === k) f.dir = -f.dir; else { f.sort = k; f.dir = 1; } this.rows(); });
      on(root, 'click', '#pmore button', () => { f.limit += 200; this.rows(); });
      this.fillCountries(); this.rows(); this.sig = this.signature();
    },
    unmount() {},
    signature() { return PSL.state.players.length + ':' + PSL.state.players.filter((p) => p.status !== 'pool').length + teamSig(); },
    update(info) { if (info.playersChanged || this.signature() !== this.sig) { this.sig = this.signature(); this.fillCountries(); this.rows(); } },
    fillCountries() {
      const codes = [...new Set(PSL.state.players.map((p) => p.country))].sort((a, b) => PSL.countryName(a).localeCompare(PSL.countryName(b)));
      const el = $('#pc', this.root);
      el.innerHTML = '<option value="">All countries</option>' + codes.map((c) => `<option value="${esc(c)}" ${this.f.country === c ? 'selected' : ''}>${esc(PSL.countryName(c))}</option>`).join('');
    },
    rows() {
      const f = this.f, root = this.root;
      let all = PSL.state.players;
      const st = (p) => p.status;
      let list = all.filter((p) => {
        if (f.status === 'auction' && !['pool', 'unsold'].includes(st(p))) return false;
        if (f.status === 'sold' && st(p) !== 'sold') return false;
        if (f.status === 'unsold' && st(p) !== 'unsold') return false;
        if (f.status === 'signed' && !['direct', 'retained'].includes(st(p))) return false;
        if (f.country && p.country !== f.country) return false;
        if (f.category && p.category !== f.category) return false;
        if (f.role && p.role !== f.role) return false;
        if (f.q && !p.name.toLowerCase().includes(f.q.toLowerCase())) return false;
        return true;
      });
      const idx = new Map(all.map((p, i) => [p.id, i]));
      const key = { order: (p) => idx.get(p.id), name: (p) => p.name.toLowerCase(), country: (p) => PSL.countryName(p.country), price: (p) => p.basePrice }[f.sort];
      list = [...list].sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * f.dir);
      const shown = list.slice(0, f.limit);
      const stat = (p) => {
        const t = PSL.team(p.teamId);
        if (p.status === 'sold') return `<span class="st sold">Sold to ${esc(t ? t.short : '')} <b>${PSL.money(p.price)}</b></span>`;
        if (p.status === 'unsold') return '<span class="st unsold">Unsold</span>';
        if (p.status === 'direct') return `<span class="st signed">Direct signing, ${esc(t ? t.short : '')}</span>`;
        if (p.status === 'retained') return `<span class="st signed">Retained by ${esc(t ? t.short : '')}</span>`;
        const a = PSL.state.auction;
        return a && a.playerId === p.id && ['live', 'paused'].includes(a.status) ? '<span class="st live">On the block</span>' : '<span class="st wait">To be auctioned</span>';
      };
      $('#pb', root).innerHTML = shown.map((p) => `<tr><td class="mut">${idx.get(p.id) + 1}</td><td><b>${esc(p.name)}</b></td><td><span class="inl">${PSL.flag(p.country)} ${esc(PSL.countryName(p.country))}</span></td><td>${roleChip(p.role)}</td><td>${catChip(p.category)}</td><td class="n gold">${PSL.money(p.basePrice)}</td><td>${stat(p)}</td></tr>`).join('') ||
        `<tr><td colspan="7" class="empty">${all.length ? 'No players match these filters.' : 'No players yet. The host will add the list soon.'}</td></tr>`;
      $('#pmore', root).innerHTML = list.length > shown.length ? `<button class="btn ghost sm">Show more (${list.length - shown.length} left)</button>` : '';
      const c = (s) => all.filter((p) => s.includes(p.status)).length;
      $('#pk', root).innerHTML = `<div><b>${all.length}</b><span>registered</span></div><div><b>${c(['pool'])}</b><span>to be auctioned</span></div><div><b>${c(['sold'])}</b><span>sold</span></div><div><b>${c(['unsold'])}</b><span>unsold</span></div>`;
      $$('th.sortable', root).forEach((th) => th.classList.toggle('sorted', th.dataset.s === f.sort));
    },
  };

  // ------------------------------------------------------------ squads
  PSL.views.squads = {
    mount(root, params) {
      this.root = root; this.sel = params[0] || (PSL.state.teams[0] && PSL.state.teams[0].id);
      on(root, 'click', '.pill', (e, b) => { this.sel = b.dataset.t; history.replaceState(null, '', '#/squads/' + this.sel); this.render(); });
      this.render(); this.sig = this.signature();
    },
    unmount() {},
    signature() { return teamSig() + PSL.state.players.filter((p) => ['direct', 'retained', 'sold'].includes(p.status)).map((p) => p.id + p.teamId + p.price).join(); },
    update() { const s = this.signature(); if (s !== this.sig) { this.sig = s; this.render(); } },
    render() {
      const S = PSL.state.settings, teams = PSL.state.teams;
      if (!teams.find((t) => t.id === this.sel)) this.sel = teams[0].id;
      const t = PSL.team(this.sel);
      const mine = PSL.state.players.filter((p) => p.teamId === t.id && ['direct', 'retained', 'sold'].includes(p.status));
      const grp = [['direct', 'Direct signings'], ['retained', 'Retained'], ['sold', 'Bought at the auction']];
      const bar = (v) => `${Math.min(100, (v / t.purseTotal) * 100)}%`;
      const sq = Math.min(100, (t.count / S.maxSquad) * 100), minPos = (S.minSquad / S.maxSquad) * 100;
      this.root.innerHTML = `
        <section class="page-head"><h1>Squads</h1><p class="lede">Every team's players and purse, from the first direct signing to the last hammer.</p></section>
        <div class="pills" role="tablist">${teams.map((x) => `<button role="tab" class="pill ${x.id === t.id ? 'on' : ''}" data-t="${x.id}" style="--tc:${esc(x.color)}">${PSL.badge(x, 'xs')}<span>${esc(x.short)}</span></button>`).join('')}</div>
        <section class="squad-head" style="--tc:${esc(t.color)}">
          <div class="sh-id">${PSL.badge(t, 'xl')}<div><h2>${esc(t.name)}</h2><small>${t.owner ? 'Owner: ' + esc(t.owner) : 'No owner assigned'}</small></div></div>
          <div class="sh-purse"><small>Purse remaining</small><b>${PSL.cr(t.remaining)}<i>Cr</i></b><span>of ${PSL.money(t.purseTotal)}${t.extension ? ' (includes ' + PSL.money(t.extension) + ' direct-signing top-up)' : ''}</span>
            <div class="stack-bar" title="Direct, retained, auction"><i class="b-d" style="width:${bar(t.directSpend)}"></i><i class="b-r" style="width:${bar(t.retainSpend)}"></i><i class="b-a" style="width:${bar(t.auctionSpend)}"></i></div>
            <div class="legend"><span><i class="b-d"></i>Direct ${PSL.cr(t.directSpend)}</span><span><i class="b-r"></i>Retained ${PSL.cr(t.retainSpend)}</span><span><i class="b-a"></i>Auction ${PSL.cr(t.auctionSpend)}</span></div></div>
          <div class="sh-sq"><small>Squad size</small><b>${t.count}<i>/ ${S.maxSquad}</i></b><div class="meter sq"><i style="width:${sq}%"></i><u style="left:${minPos}%" title="Minimum ${S.minSquad}"></u></div><span>${t.count < S.minSquad ? `${S.minSquad - t.count} more to reach the minimum of ${S.minSquad}` : 'Minimum squad reached'}</span><span>Overseas ${t.overseas} of ${S.maxOverseas}</span></div>
        </section>
        <section class="squad-groups">${grp.map(([k, label]) => { const g = mine.filter((p) => p.status === k); return `<div class="card-wide"><h3>${label} <span class="mut">${g.length}</span></h3><ul class="plist">${g.length ? g.map((p) => pRow(p)).join('') : '<li class="empty">Nobody yet</li>'}</ul></div>`; }).join('')}</section>
        <section class="card-wide scroll-x"><h3>All teams</h3><table class="tbl"><thead><tr><th>Team</th><th class="n">Players</th><th class="n">Overseas</th><th class="n">Direct</th><th class="n">Retained</th><th class="n">Auction</th><th class="n">Purse remaining</th></tr></thead><tbody>${teams.map((x) => `<tr class="${x.id === t.id ? 'hl' : ''}"><td><a class="tl" href="#/squads/${x.id}">${PSL.badge(x, 'xs')}<span>${esc(x.name)}</span></a></td><td class="n">${x.count}</td><td class="n">${x.overseas}</td><td class="n">${PSL.cr(x.directSpend)}</td><td class="n">${PSL.cr(x.retainSpend)}</td><td class="n">${PSL.cr(x.auctionSpend)}</td><td class="n strong">${PSL.money(x.remaining)}</td></tr>`).join('')}</tbody></table></section>`;
    },
  };
})();
