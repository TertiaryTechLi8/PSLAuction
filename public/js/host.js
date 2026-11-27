/* Host console: control centre, players import, signings, teams & users, registrations, data */
(function () {
  const { $, $$, esc, on } = PSL;

  const ROLES = ['Batter', 'Bowler', 'All-rounder', 'WK-Batter'];
  const CATS = ['Platinum', 'Diamond', 'Gold', 'Silver', 'Emerging'];
  const roleChip = (r) => `<span class="role r-${esc((r || '').replace(/[^A-Za-z]/g, '').toLowerCase())}">${esc(r || '')}</span>`;
  const catChip = (c) => (c ? `<span class="cat c-${esc(c.toLowerCase())}">${esc(c)}</span>` : '');
  const opts = (arr, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + arr.map((x) => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const teamOpts = (sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + PSL.state.teams.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const crInput = (v) => (v / 1e7).toString();

  // ---------------------------------------------------------- sheet parsing
  function parseDelimited(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
    const delim = (first.match(/\t/g) || []).length ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim()));
  }

  // 1.1 / "1.1 cr" / "60 lakh" / 6000000. Bare numbers: <=10 crore, >=100000 rupees, otherwise lakh.
  function parseMoney(v) {
    const s = String(v == null ? '' : v).toLowerCase().replace(/rs\.?|pkr|,/g, '').trim();
    const m = s.match(/^([\d.]+)\s*(crore|cr|c|lakhs?|lacs?|lac|l|m|million)?$/);
    if (!m) return null;
    const n = parseFloat(m[1]); if (!isFinite(n)) return null;
    const u = m[2];
    if (u && /^c/.test(u)) return Math.round(n * 1e7);
    if (u && /^l/.test(u)) return Math.round(n * 1e5);
    if (u && /^m/.test(u)) return Math.round(n * 1e6);
    if (n <= 10) return Math.round(n * 1e7);
    if (n >= 100000) return Math.round(n);
    return Math.round(n * 1e5);
  }
  function normRole(v) {
    const s = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!s) return '';
    if (/^(wk|wkt|keeper|wicketkeeper)/.test(s) || s.includes('wicketkeeper')) return 'WK-Batter';
    if (s.includes('allround') || s === 'ar' || s === 'allrounder') return 'All-rounder';
    if (s.includes('bowl')) return 'Bowler';
    if (s.includes('bat')) return 'Batter';
    return '';
  }
  function normCat(v) { const s = String(v || '').trim().toLowerCase(); return CATS.find((c) => c.toLowerCase() === s) || ''; }
  function rowsToPlayers(rows) {
    if (!rows.length) return [];
    const head = rows[0].map((c) => String(c).toLowerCase().trim());
    const hasHead = head.some((h) => /name|player/.test(h)) && !head.some((h) => /^[\d.]+$/.test(h));
    const col = { name: 0, country: 1, price: 2, role: 3, category: 4 };
    if (hasHead) {
      const find = (re) => head.findIndex((h) => re.test(h));
      col.name = find(/name|player/); col.country = find(/country|nation/); col.price = find(/price|base|crore|\bcr\b|amount/);
      col.role = find(/role|skill|type/); col.category = find(/categ|tier|band/);
      if (col.name < 0) col.name = 0;
    }
    return rows.slice(hasHead ? 1 : 0).map((r) => {
      const g = (k) => (col[k] >= 0 && col[k] != null ? String(r[col[k]] == null ? '' : r[col[k]]).trim() : '');
      const countryRaw = g('country');
      const code = countryRaw ? PSL.resolveCountry(countryRaw) : 'pk';
      const price = g('price') ? parseMoney(g('price')) : null;
      return { name: g('name'), countryRaw, country: code, basePrice: price, role: normRole(g('role')) || 'All-rounder', category: normCat(g('category')) };
    }).filter((p) => p.name);
  }
  function loadSheetJS() {
    return new Promise((res, rej) => {
      if (window.XLSX) return res(window.XLSX);
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('Could not load the Excel reader (needs internet). Save the sheet as CSV instead.'));
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------- the view
  PSL.views.host = {
    tab: 'control',
    mount(root) {
      this.root = root;
      root.innerHTML = `
        <section class="page-head"><h1>Host console</h1><p class="lede">Everything for running the night: where the train is, what visitors see, the player list, signings, logins and the live room.</p></section>
        <div class="tabs" id="htabs">${[['control', 'Control centre'], ['players', 'Players'], ['signings', 'Signings'], ['teams', 'Teams and logins'], ['regs', 'Registrations'], ['data', 'Data']].map(([k, l]) => `<button data-k="${k}" class="${k === this.tab ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div id="hbody"></div>`;
      on(root, 'click', '#htabs button', (e, b) => { this.tab = b.dataset.k; $$('#htabs button', root).forEach((x) => x.classList.toggle('on', x === b)); this.renderTab(); });
      this.renderTab();
    },
    unmount() {},
    update(info) {
      const t = this.tab;
      if (t === 'control') this.markControl();
      else if (t === 'players' && info.playersChanged) this.renderQueue();
      else if (t === 'signings') { if (info.playersChanged) this.renderSigningList(); this.updatePreview && this.updatePreview(); }
      else if (t === 'regs') this.renderRegs();
    },
    renderTab() { const fn = this['tab_' + this.tab]; $('#hbody', this.root).innerHTML = ''; this.body = $('#hbody', this.root); fn.call(this); },
    async call(action, body, okMsg) {
      const r = await PSL.host(action, body);
      if (!r.ok) { PSL.toast(r.error || 'Something went wrong', 'bad'); return r; }
      if (okMsg) PSL.toast(okMsg, 'ok');
      return r;
    },

    // ======================================================== control centre
    tab_control() {
      const S = PSL.state.settings;
      this.body.innerHTML = `
        <div class="hgrid2">
          <section class="card-wide"><h3>Where is the train?</h3><p class="mut">Moves the train on the home page. Visitors see it travel to the stop you pick.</p>
            <div class="choice" id="stage-choice">
              <button data-stage="direct"><b>Direct Signing</b><small>Stop 1</small></button>
              <button data-stage="retention"><b>Retention</b><small>Stop 2</small></button>
              <button data-stage="auction"><b>Gaddafi Stadium</b><small>Auction day</small></button>
            </div></section>
          <section class="card-wide"><h3>What does the Auction tab show?</h3><p class="mut">You always see the live room. This switch controls what everybody else sees, including your friends.</p>
            <div class="choice" id="mode-choice">
              <button data-mode="coming_soon"><b>Coming soon</b><small>Countdown page</small></button>
              <button data-mode="register"><b>Register yourself</b><small>Sign-up form</small></button>
              <button data-mode="watch"><b>Watch auction</b><small>Live room, bidding on</small></button>
            </div>
            <div class="frow"><label>Auction date and time<input type="datetime-local" id="adate" value="${esc(/^\d{4}-\d\d-\d\dT/.test(S.auctionDate) ? S.auctionDate.slice(0, 16) : '')}"></label><label>Venue<input id="avenue" value="${esc(S.venue)}"></label><button class="btn" id="save-when">Save</button></div>
            <div class="row gap"><a class="btn" href="#/auction">Open the auction room</a></div></section>
        </div>
        <section class="card-wide"><h3>Rules and timers</h3><p class="mut">Defaults follow the first PSL auction: Rs 45 Cr purse, up to Rs 5.5 Cr extra for a direct signing, squads of 16 to 20.</p>
          <form id="rules" class="rules">
            ${[['pursePkr', 'Team purse (Cr)', 1], ['directExtension', 'Direct signing top-up, max (Cr)', 1], ['reservePerSlot', 'Purse kept back per empty squad slot (Cr, 0 = off)', 1], ['minSquad', 'Minimum squad'], ['maxSquad', 'Maximum squad'], ['maxOverseas', 'Maximum overseas players'], ['maxDirect', 'Direct signings per team'], ['maxRetention', 'Retentions per team'], ['goldenPaddles', 'Golden Paddles per team'], ['timerSeconds', 'Seconds per player'], ['bidResetSeconds', 'Timer resets to at least (sec) after a bid']].map(([k, l, c]) => `<label>${l}<input name="${k}" type="number" step="${c ? '0.005' : '1'}" min="0" value="${c ? crInput(S[k]) : S[k]}"></label>`).join('')}
            <label class="chk wide"><input type="checkbox" name="autoFinalize" ${S.autoFinalize ? 'checked' : ''}> Sell or mark unsold automatically when the timer ends</label>
            <div class="wide"><h4>Minimum bid increments</h4><p class="mut small">Applies to the current bid. Leave "Up to" empty on the last row.</p><div id="slabs"></div><button type="button" class="btn ghost sm" id="addslab">Add a row</button></div>
            <label class="wide">Base price choices (Cr, comma separated)<input name="tiers" value="${esc(S.basePriceTiers.map((x) => x / 1e7).join(', '))}"></label>
            <div class="wide"><button class="btn">Save rules</button></div>
          </form></section>`;
      this.drawSlabs(S.slabs);
      this.markControl();
      on(this.body, 'click', '[data-stage]', (e, b) => this.call('settings', { stage: b.dataset.stage }, 'Train moved'));
      on(this.body, 'click', '[data-mode]', (e, b) => this.call('settings', { auctionMode: b.dataset.mode }, 'Auction tab updated'));
      $('#save-when', this.body).onclick = () => this.call('settings', { auctionDate: $('#adate', this.body).value, venue: $('#avenue', this.body).value }, 'Saved');
      $('#addslab', this.body).onclick = () => { const cur = this.readSlabs(); cur.splice(cur.length - 1, 0, { upto: '', inc: '' }); this.drawSlabs(cur.map((x) => ({ upto: x.upto === '' ? 0 : x.upto * 1e7, inc: x.inc === '' ? 0 : x.inc * 1e7 })).concat([]), true); };
      on(this.body, 'click', '[data-rmslab]', (e, b) => { b.closest('.slabrow').remove(); });
      $('#rules', this.body).onsubmit = (e) => {
        e.preventDefault();
        const f = e.target, body = {};
        ['pursePkr', 'directExtension', 'reservePerSlot'].forEach((k) => (body[k] = PSL.toCr(f[k].value)));
        ['minSquad', 'maxSquad', 'maxOverseas', 'maxDirect', 'maxRetention', 'goldenPaddles', 'timerSeconds', 'bidResetSeconds'].forEach((k) => (body[k] = Number(f[k].value)));
        body.autoFinalize = f.autoFinalize.checked;
        body.basePriceTiers = f.tiers.value.split(',').map((x) => PSL.toCr(x.trim())).filter((x) => x > 0);
        body.slabs = this.readSlabs().map((s) => ({ upto: s.upto === '' ? null : PSL.toCr(s.upto), inc: PSL.toCr(s.inc) }));
        this.call('settings', body, 'Rules saved');
      };
    },
    drawSlabs(slabs, raw) {
      $('#slabs', this.body).innerHTML = slabs.map((s, i) => `<div class="slabrow"><span>Up to</span><input type="number" step="0.005" class="su" value="${s.upto == null || (raw && !s.upto) ? '' : s.upto / 1e7}" ${s.upto == null && i === slabs.length - 1 ? 'placeholder="no limit"' : ''}><span>Cr, increase by</span><input type="number" step="0.005" class="si" value="${s.inc ? s.inc / 1e7 : ''}"><span>Cr</span>${i === slabs.length - 1 ? '' : '<button type="button" class="btn ghost sm" data-rmslab>Remove</button>'}</div>`).join('');
    },
    readSlabs() { return $$('.slabrow', this.body).map((r) => ({ upto: $('.su', r).value, inc: $('.si', r).value })); },
    markControl() {
      const S = PSL.state.settings;
      $$('#stage-choice button', this.body).forEach((b) => b.classList.toggle('on', b.dataset.stage === S.stage));
      $$('#mode-choice button', this.body).forEach((b) => b.classList.toggle('on', b.dataset.mode === S.auctionMode));
    },

    // ======================================================== players
    tab_players() {
      const S = PSL.state.settings;
      this.body.innerHTML = `
        <section class="card-wide"><h3>Upload the player list</h3>
          <p class="mut">Drop an Excel or CSV file, or paste rows. Columns: <b>Name, Country, Base price, Role, Category</b>. Prices can be in crore (1.1), lakh (60 lakh) or rupees. Role and category are optional.
          <a href="/templates/players-template.csv" download>Download the template</a></p>
          <div class="drop" id="drop"><input type="file" id="file" accept=".csv,.tsv,.txt,.xlsx,.xls" hidden><b>Drop a file here</b><span>or <button type="button" class="linkbtn" id="pick">choose a file</button></span></div>
          <details class="paste"><summary>Or paste rows from a sheet</summary><textarea id="paste" rows="6" placeholder="Babar Azam, Pakistan, 4.2, Batter, Platinum&#10;Rashid Khan, Afghanistan, 4.2, Bowler, Platinum"></textarea><button class="btn sm" id="parse-paste">Read pasted rows</button></details>
          <div id="preview"></div></section>
        <section class="card-wide"><h3>Add one player</h3>
          <form id="addp" class="addp">
            <label>Name<input name="name" required maxlength="60" placeholder="Player name"></label>
            <label>Country<div id="addfs"></div></label>
            <label>Base price (Cr)<input name="price" type="number" step="0.005" min="0" list="tiers" value="${S.basePriceTiers.length ? S.basePriceTiers[0] / 1e7 : 0.6}" required><datalist id="tiers">${S.basePriceTiers.map((x) => `<option value="${x / 1e7}">`).join('')}</datalist></label>
            <label>Role<select name="role">${opts(ROLES, 'Batter')}</select></label>
            <label>Category<select name="category">${opts(CATS, '', 'None')}</select></label>
            <button class="btn">Add player</button>
          </form></section>
        <section class="card-wide"><div class="qhead"><h3>Auction queue <span class="mut" id="qcount"></span></h3>
          <div class="row gap wrap"><input id="qsearch" type="search" placeholder="Search the queue"><button class="btn ghost sm" id="shuffle">Shuffle order</button><button class="btn ghost sm" id="retun">Return unsold to queue</button><button class="btn danger sm" id="clearq">Clear queue</button></div></div>
          <p class="mut small">Players are called in this order. Use "To top" to bring someone forward, or "Play now" in the live room.</p>
          <div class="scroll-x"><table class="tbl"><thead><tr><th>#</th><th>Player</th><th>Country</th><th>Role</th><th>Category</th><th class="n">Base price</th><th></th></tr></thead><tbody id="qbody"></tbody></table></div><div class="more" id="qmore"></div></section>`;
      this.qlimit = 150;
      this.addfs = PSL.flagSelect($('#addfs', this.body), { value: 'pk' });
      const drop = $('#drop', this.body), file = $('#file', this.body);
      $('#pick', this.body).onclick = () => file.click();
      file.onchange = () => file.files[0] && this.readFile(file.files[0]);
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) this.readFile(f); });
      $('#parse-paste', this.body).onclick = () => this.preview(rowsToPlayers(parseDelimited($('#paste', this.body).value)));
      $('#addp', this.body).onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const r = await this.call('playerAdd', { name: f.name.value, country: this.addfs.getValue(), basePrice: PSL.toCr(f.price.value), role: f.role.value, category: f.category.value }, 'Player added');
        if (r.ok) { f.name.value = ''; f.name.focus(); }
      };
      $('#qsearch', this.body).oninput = () => { this.qlimit = 150; this.renderQueue(); };
      $('#shuffle', this.body).onclick = async () => { if (await PSL.confirm('Shuffle the queue?', 'The order of players still waiting will be randomised.', 'Shuffle')) this.call('playersShuffle', {}, 'Queue shuffled'); };
      $('#retun', this.body).onclick = async () => { const r = await this.call('returnUnsold'); if (r.ok) PSL.toast(`${r.returned} unsold player(s) back in the queue`, 'ok'); };
      $('#clearq', this.body).onclick = async () => { if (await PSL.confirm('Clear the whole queue?', 'This removes every player waiting to be auctioned. Direct signings, retentions and sold players stay.', 'Clear queue')) this.call('playersClear', {}, 'Queue cleared'); };
      on(this.body, 'click', '[data-qa]', async (e, b) => {
        const id = b.dataset.id, a = b.dataset.qa;
        if (a === 'top') this.call('playerMove', { id, to: 'top' });
        if (a === 'del') { if (await PSL.confirm('Delete this player?', esc(PSL.player(id).name), 'Delete')) this.call('playerDelete', { id }); }
        if (a === 'edit') this.editPlayer(id);
      });
      on(this.body, 'click', '#qmore button', () => { this.qlimit += 300; this.renderQueue(); });
      this.renderQueue();
    },
    renderQueue() {
      const q = ($('#qsearch', this.body).value || '').toLowerCase();
      const all = PSL.state.players.filter((p) => ['pool', 'unsold'].includes(p.status));
      const list = all.filter((p) => !q || p.name.toLowerCase().includes(q));
      const shown = list.slice(0, this.qlimit);
      const a = PSL.state.auction;
      $('#qcount', this.body).textContent = `${all.length} waiting`;
      $('#qbody', this.body).innerHTML = shown.map((p, i) => `<tr><td class="mut">${all.indexOf(p) + 1}</td><td><b>${esc(p.name)}</b>${p.status === 'unsold' ? ' <span class="st unsold">Unsold</span>' : ''}${a.playerId === p.id && ['live', 'paused'].includes(a.status) ? ' <span class="st live">On the block</span>' : ''}</td><td><span class="inl">${PSL.flag(p.country)} ${esc(PSL.countryName(p.country))}</span></td><td>${roleChip(p.role)}</td><td>${catChip(p.category)}</td><td class="n gold">${PSL.money(p.basePrice)}</td><td class="acts"><button class="btn ghost sm" data-qa="top" data-id="${p.id}">To top</button><button class="btn ghost sm" data-qa="edit" data-id="${p.id}">Edit</button><button class="btn ghost sm" data-qa="del" data-id="${p.id}">Delete</button></td></tr>`).join('') ||
        `<tr><td colspan="7" class="empty">${all.length ? 'No match.' : 'The queue is empty. Upload a list above or add players one by one.'}</td></tr>`;
      $('#qmore', this.body).innerHTML = list.length > shown.length ? `<button class="btn ghost sm">Show more (${list.length - shown.length} left)</button>` : '';
    },
    editPlayer(id) {
      const p = PSL.player(id); if (!p) return;
      const m = PSL.modal(`<h3>Edit player</h3><form id="ef" class="stack"><label>Name<input name="name" value="${esc(p.name)}" required></label><label>Country<div id="efs"></div></label><label>Base price (Cr)<input name="price" type="number" step="0.005" value="${p.basePrice / 1e7}"></label><label>Role<select name="role">${opts(ROLES, p.role)}</select></label><label>Category<select name="category">${opts(CATS, p.category, 'None')}</select></label><div class="row end gap"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
      const fs = PSL.flagSelect($('#efs', m.el), { value: p.country });
      $('#ef', m.el).onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        const r = await this.call('playerUpdate', { id, name: f.name.value, country: fs.getValue(), basePrice: PSL.toCr(f.price.value), role: f.role.value, category: f.category.value }, 'Saved');
        if (r.ok) m.close();
      };
    },
    async readFile(file) {
      try {
        let rows;
        if (/\.(xlsx|xls)$/i.test(file.name)) {
          const X = await loadSheetJS();
          const wb = X.read(await file.arrayBuffer(), { type: 'array' });
          rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
        } else rows = parseDelimited(await file.text());
        this.preview(rowsToPlayers(rows), file.name);
      } catch (e) { PSL.toast(e.message || 'Could not read that file', 'bad'); }
    },
    preview(list, fname) {
      const box = $('#preview', this.body);
      if (!list.length) { box.innerHTML = '<div class="note warn">No players found. Check that the first column holds player names.</div>'; return; }
      this.pv = list;
      const draw = () => {
        const bad = list.filter((p) => !p.country).length, noPrice = list.filter((p) => p.basePrice == null).length;
        box.innerHTML = `<div class="pv-head"><b>${list.length} players found${fname ? ' in ' + esc(fname) : ''}</b>${bad ? `<span class="st unsold">${bad} need a country</span>` : ''}${noPrice ? `<span class="st unsold">${noPrice} need a price</span>` : ''}</div>
          <div class="scroll-x pv-scroll"><table class="tbl"><thead><tr><th>#</th><th>Name</th><th>Country</th><th class="n">Base price</th><th>Role</th><th>Category</th></tr></thead><tbody>${list.slice(0, 300).map((p, i) => `<tr class="${!p.country || p.basePrice == null ? 'warn' : ''}"><td class="mut">${i + 1}</td><td>${esc(p.name)}</td><td>${p.country ? `<span class="inl">${PSL.flag(p.country)} ${esc(PSL.countryName(p.country))}</span>` : `<div class="pvfs" data-i="${i}"></div><small class="mut">"${esc(p.countryRaw)}"</small>`}</td><td class="n">${p.basePrice != null ? PSL.money(p.basePrice) : `<input class="pvprice" data-i="${i}" type="number" step="0.005" placeholder="Cr">`}</td><td>${roleChip(p.role)}</td><td>${catChip(p.category)}</td></tr>`).join('')}</tbody></table>${list.length > 300 ? `<p class="mut small">Showing the first 300 rows. All ${list.length} will be imported.</p>` : ''}</div>
          <div class="row gap"><button class="btn" id="imp-add">Add to the queue</button><button class="btn ghost" id="imp-rep">Replace the queue</button><button class="btn ghost" id="imp-cancel">Cancel</button></div>`;
        $$('.pvfs', box).forEach((h) => PSL.flagSelect(h, { value: '', compact: true, onChange: (v) => { list[h.dataset.i].country = v; draw(); } }));
        $$('.pvprice', box).forEach((inp) => (inp.onchange = () => { list[inp.dataset.i].basePrice = PSL.toCr(inp.value); draw(); }));
        $('#imp-cancel', box).onclick = () => (box.innerHTML = '');
        const go = async (mode) => {
          if (list.some((p) => !p.country || p.basePrice == null)) return PSL.toast('Fix the highlighted rows first', 'bad');
          if (mode === 'replace' && !(await PSL.confirm('Replace the queue?', 'Players waiting to be auctioned will be swapped for this list. Signings and sold players stay.', 'Replace'))) return;
          const r = await this.call('playersImport', { mode, players: list.map((p) => ({ name: p.name, country: p.country, basePrice: p.basePrice, role: p.role, category: p.category })) });
          if (r.ok) { PSL.toast(`${r.added} players added`, 'ok'); box.innerHTML = ''; }
        };
        $('#imp-add', box).onclick = () => go('append'); $('#imp-rep', box).onclick = () => go('replace');
      };
      draw();
    },

    // ======================================================== signings
    tab_signings() {
      const S = PSL.state.settings;
      this.body.innerHTML = `
        <section class="card-wide"><h3>Add a direct signing or retention</h3>
          <p class="mut">The price is taken off the team's purse straight away. Visitors see it on the Direct signings and Retentions tabs.</p>
          <form id="sf" class="sform">
            <div class="seg" id="skind"><button type="button" data-k="direct" class="on">Direct signing</button><button type="button" data-k="retained">Retention</button></div>
            <label>Team<select name="team" required>${teamOpts('', 'Choose a team')}</select></label>
            <div class="seg" id="ssrc"><button type="button" data-k="list" class="on">From the player list</button><button type="button" data-k="new">New player</button></div>
            <label class="src-list">Player<input name="pick" list="plist" placeholder="Start typing a name" autocomplete="off"><datalist id="plist"></datalist></label>
            <div class="src-new" hidden>
              <label>Name<input name="name" maxlength="60"></label>
              <label>Country<div id="sfs"></div></label>
              <label>Role<select name="role">${opts(ROLES, 'Batter')}</select></label>
              <label>Category<select name="category">${opts(CATS, '', 'None')}</select></label>
            </div>
            <label>Price (Cr)<input name="price" type="number" step="0.005" min="0" required></label>
            <div class="preview" id="spv"></div>
            <button class="btn">Add signing</button>
          </form></section>
        <section id="slist"></section>`;
      this.skind = 'direct'; this.ssrc = 'list';
      this.sfs = PSL.flagSelect($('#sfs', this.body), { value: 'pk' });
      const f = $('#sf', this.body);
      const fillList = () => {
        const pool = PSL.state.players.filter((p) => ['pool', 'unsold'].includes(p.status));
        $('#plist', this.body).innerHTML = pool.slice(0, 1200).map((p) => `<option value="${esc(p.name)} (${esc(PSL.countryName(p.country))})">`).join('');
      };
      fillList(); this.fillList = fillList;
      on(this.body, 'click', '#skind button', (e, b) => { this.skind = b.dataset.k; $$('#skind button', this.body).forEach((x) => x.classList.toggle('on', x === b)); this.updatePreview(); });
      on(this.body, 'click', '#ssrc button', (e, b) => { this.ssrc = b.dataset.k; $$('#ssrc button', this.body).forEach((x) => x.classList.toggle('on', x === b)); $('.src-list', this.body).hidden = this.ssrc !== 'list'; $('.src-new', this.body).hidden = this.ssrc !== 'new'; });
      this.updatePreview = () => {
        const t = PSL.team(f.team.value), price = PSL.toCr(f.price.value || 0);
        const el = $('#spv', this.body); if (!el) return;
        if (!t || !price) { el.textContent = ''; return; }
        const ext = this.skind === 'direct' && t.directCount === 0 ? Math.min(S.directExtension, price) : 0;
        const after = t.remaining + ext - price;
        el.innerHTML = `${esc(t.name)} purse: ${PSL.money(t.remaining)} to <b class="${after < 0 ? 'neg' : ''}">${PSL.money(after)}</b>${ext ? ` (includes a ${PSL.money(ext)} direct-signing top-up)` : ''}`;
      };
      f.team.onchange = f.price.oninput = this.updatePreview;
      f.onsubmit = async (e) => {
        e.preventDefault();
        const body = { kind: this.skind, teamId: f.team.value, price: PSL.toCr(f.price.value) };
        if (this.ssrc === 'list') {
          const p = PSL.state.players.find((x) => ['pool', 'unsold'].includes(x.status) && `${x.name} (${PSL.countryName(x.country)})` === f.pick.value);
          if (!p) return PSL.toast('Pick a player from the suggestions, or use New player', 'bad');
          body.playerId = p.id;
        } else Object.assign(body, { name: f.name.value, country: this.sfs.getValue(), role: f.role.value, category: f.category.value });
        let r = await PSL.host('signingAdd', body);
        if (!r.ok && /^LIMIT:/.test(r.error || '')) {
          if (await PSL.confirm('Add anyway?', esc(r.error.replace('LIMIT: ', '')), 'Add anyway')) r = await PSL.host('signingAdd', { ...body, force: true });
          else return;
        }
        if (!r.ok) return PSL.toast(r.error, 'bad');
        PSL.toast('Signing added', 'ok'); f.pick.value = ''; f.name.value = ''; f.price.value = ''; this.updatePreview(); fillList();
      };
      this.renderSigningList();
    },
    renderSigningList() {
      const el = $('#slist', this.body); if (!el) return;
      const sign = PSL.state.players.filter((p) => ['direct', 'retained'].includes(p.status));
      if (this.fillList) this.fillList();
      el.innerHTML = `<div class="grid-teams">${PSL.state.teams.map((t) => {
        const mine = sign.filter((p) => p.teamId === t.id);
        return `<article class="tcard2" style="--tc:${esc(t.color)}"><header>${PSL.badge(t, 'md')}<div><h3>${esc(t.name)}</h3><small>Purse remaining ${PSL.money(t.remaining)}</small></div></header>
          <ul class="plist">${mine.map((p) => `<li class="prow"><span class="pf">${PSL.flag(p.country)}</span><div class="pn"><b>${esc(p.name)}</b><small>${p.status === 'direct' ? 'Direct signing' : 'Retention'}</small></div><span class="pp">${PSL.money(p.price)}</span><button class="btn ghost sm" data-se="edit" data-id="${p.id}">Edit</button><button class="btn ghost sm" data-se="rm" data-id="${p.id}">Remove</button></li>`).join('') || '<li class="empty">No signings yet</li>'}</ul></article>`;
      }).join('')}</div>`;
      if (!this._seBound) {
        this._seBound = true;
        on(this.body, 'click', '[data-se]', async (e, b) => {
          const id = b.dataset.id, p = PSL.player(id);
          if (b.dataset.se === 'rm') { if (await PSL.confirm('Remove this signing?', `${esc(p.name)} goes back to the auction queue (or is deleted if you created them here).`, 'Remove')) this.call('signingRemove', { id }, 'Removed'); }
          else {
            const m = PSL.modal(`<h3>Edit ${esc(p.name)}</h3><form id="sef" class="stack"><label>Team<select name="team">${teamOpts(p.teamId)}</select></label><label>Price (Cr)<input name="price" type="number" step="0.005" value="${p.price / 1e7}"></label><div class="row end gap"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
            $('#sef', m.el).onsubmit = async (ev) => { ev.preventDefault(); const r = await this.call('signingUpdate', { id, teamId: ev.target.team.value, price: PSL.toCr(ev.target.price.value) }, 'Saved'); if (r.ok) m.close(); };
          }
        });
      }
    },

    // ======================================================== teams and logins
    tab_teams() {
      const admin = PSL.state.admin; const users = admin ? admin.users : [];
      const url = location.origin;
      this.body.innerHTML = `
        <section class="card-wide"><h3>Teams</h3><p class="mut">Rename a team or change its colour. To show a team logo, put <code>&lt;team id&gt;.png</code> in <code>public/assets/teams/</code> (for example <code>isu.png</code>).</p>
          <form id="tf"><div class="scroll-x"><table class="tbl"><thead><tr><th>Id</th><th>Name</th><th>Short</th><th>Colour</th></tr></thead><tbody>${PSL.state.teams.map((t) => `<tr data-id="${t.id}"><td class="mut">${t.id}</td><td><input class="tn" value="${esc(t.name)}"></td><td><input class="ts" value="${esc(t.short)}" maxlength="5" size="5"></td><td><input class="tc" type="color" value="${esc(t.color)}"></td></tr>`).join('')}</tbody></table></div><button class="btn">Save teams</button></form></section>
        <section class="card-wide"><h3>Logins (1 host and 8 team owners)</h3><p class="mut">Share each friend's username and password with them privately. Anyone who opens <b>${esc(url)}</b> can watch; only these logins can bid.</p>
          <form id="uf"><div class="scroll-x"><table class="tbl"><thead><tr><th>Role</th><th>Display name</th><th>Username</th><th>Password</th><th>Team</th></tr></thead><tbody>${users.map((u) => `<tr data-id="${u.id}"><td>${u.role === 'host' ? 'Host' : 'Team owner'}</td><td><input class="un" value="${esc(u.displayName)}"></td><td><input class="uu" value="${esc(u.username)}" autocapitalize="none"></td><td><input class="up" value="${esc(u.password)}" autocapitalize="none"></td><td>${u.role === 'host' ? '<span class="mut">All teams</span>' : `<select class="ut">${teamOpts(u.teamId)}</select>`}</td></tr>`).join('')}</tbody></table></div>
          <div class="row gap"><button class="btn">Save logins</button><button type="button" class="btn ghost" id="copylog">Copy all logins</button></div></form></section>`;
      $('#tf', this.body).onsubmit = (e) => { e.preventDefault(); this.call('teams', { teams: $$('#tf tbody tr', this.body).map((r) => ({ id: r.dataset.id, name: $('.tn', r).value, short: $('.ts', r).value, color: $('.tc', r).value })) }, 'Teams saved'); };
      $('#uf', this.body).onsubmit = (e) => { e.preventDefault(); this.call('users', { users: $$('#uf tbody tr', this.body).map((r) => ({ id: r.dataset.id, displayName: $('.un', r).value, username: $('.uu', r).value, password: $('.up', r).value, teamId: $('.ut', r) ? $('.ut', r).value : null })) }, 'Logins saved'); };
      $('#copylog', this.body).onclick = async () => {
        const text = `Tertiary Tech presents PSL - auction logins\nOpen: ${url}\n\n` + $$('#uf tbody tr', this.body).map((r) => `${$('.un', r).value}: username ${$('.uu', r).value}, password ${$('.up', r).value}${$('.ut', r) ? ' (' + (PSL.team($('.ut', r).value) || {}).name + ')' : ''}`).join('\n');
        try { await navigator.clipboard.writeText(text); PSL.toast('Logins copied', 'ok'); } catch { PSL.toast('Copy failed. Use data/credentials.txt instead.', 'bad'); }
      };
    },

    // ======================================================== registrations
    tab_regs() {
      this.body.innerHTML = '<section class="card-wide"><h3>Registrations</h3><div id="rbody"></div></section>';
      on(this.body, 'click', '[data-rd]', (e, b) => this.call('regDelete', { id: b.dataset.rd }));
      this.renderRegs();
    },
    renderRegs() {
      const el = $('#rbody', this.body); if (!el) return;
      const regs = (PSL.state.admin && PSL.state.admin.registrations) || [];
      el.innerHTML = regs.length ? `<div class="scroll-x"><table class="tbl"><thead><tr><th>Name</th><th>Contact</th><th>Team wanted</th><th>Note</th><th>When</th><th></th></tr></thead><tbody>${regs.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.contact)}</td><td>${esc(r.team)}</td><td>${esc(r.note)}</td><td class="mut">${new Date(r.at).toLocaleString()}</td><td><button class="btn ghost sm" data-rd="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nobody has registered yet. Switch the Auction tab to "Register yourself" to collect sign-ups.</p>';
    },

    // ======================================================== data
    tab_data() {
      this.body.innerHTML = `
        <section class="card-wide"><h3>Sample data</h3><p class="mut">Fills the site with a sample set of signings, retentions and a player list so you can see every page working. The values are illustrative, replace them with your own.</p><button class="btn" id="demo">Load sample data</button></section>
        <section class="card-wide"><h3>Backup</h3><p class="mut">Everything is saved automatically on the server. Download a copy before big changes.</p><div class="row gap"><button class="btn ghost" id="exp">Download backup</button><button class="btn ghost" id="imp">Restore from backup</button><input type="file" id="impf" accept=".json" hidden></div></section>
        <section class="card-wide danger-zone"><h3>Reset</h3><p class="mut">Start the auction night again without losing your players, signings or logins.</p><div class="row gap"><button class="btn danger" id="rauc">Reset auction results</button><button class="btn danger" id="rall">Erase all players, signings and results</button></div></section>`;
      $('#demo', this.body).onclick = async () => { if (await PSL.confirm('Load sample data?', 'This replaces the current players, signings and results.', 'Load sample data')) this.call('loadDemo', {}, 'Sample data loaded'); };
      $('#rauc', this.body).onclick = async () => { if (await PSL.confirm('Reset auction results?', 'Everyone sold or unsold during the auction goes back into the queue and purses are restored. Direct signings and retentions stay.', 'Reset results')) this.call('resetAuction', {}, 'Auction reset'); };
      $('#rall', this.body).onclick = async () => { if (await PSL.confirm('Erase everything?', 'All players, signings, results and registrations are removed. Logins and settings stay.', 'Erase everything')) this.call('resetAll', {}, 'All cleared'); };
      $('#exp', this.body).onclick = async () => {
        const r = await fetch('/api/host/export', { headers: { Authorization: 'Bearer ' + PSL.token } });
        const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'psl-auction-backup.json'; a.click();
      };
      $('#imp', this.body).onclick = () => $('#impf', this.body).click();
      $('#impf', this.body).onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const backup = JSON.parse(await f.text()); if (await PSL.confirm('Restore this backup?', 'The current data is replaced.', 'Restore')) this.call('importBackup', { backup }, 'Backup restored'); } catch { PSL.toast('That file is not a valid backup', 'bad'); }
      };
    },
  };
})();
