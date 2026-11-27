'use strict';
// End-to-end smoke test. Starts the server on a temp port/data dir, then drives it like the real clients do.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const PORT = 3999;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'psl-test-'));
const BASE = `http://localhost:${PORT}`;
const CR = 1e7;
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body, token) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
  return r.json();
}

function client(token) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token || ''}`);
  const c = { ws, state: null, acks: new Map(), ref: 1, players: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'state') { c.state = m; if (m.players) c.players = m.players; }
    if (m.type === 'ack') { const f = c.acks.get(m.ref); if (f) f(m); }
  });
  c.send = (o) => new Promise((res) => { const ref = c.ref++; c.acks.set(ref, res); ws.send(JSON.stringify({ ...o, ref })); });
  c.ready = new Promise((r) => ws.on('open', r));
  return c;
}

(async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => /Logins/.test(String(d)) && r()));
  try {
    const creds = fs.readFileSync(path.join(DATA, 'credentials.txt'), 'utf8');
    const get = (u) => (creds.match(new RegExp(`username: ${u}\\s+password: (\\S+)`)) || [])[1];
    console.log('Auth');
    ok((creds.match(/username:/g) || []).length === 9, '9 logins created (1 host + 8 team owners)');
    ok((await api('/api/login', { username: 'host', password: 'wrong' })).ok === false, 'wrong password rejected');
    const H = await api('/api/login', { username: 'host', password: get('host') });
    const F1 = await api('/api/login', { username: 'friend1', password: get('friend1') });
    const F2 = await api('/api/login', { username: 'friend2', password: get('friend2') });
    ok(H.ok && F1.ok && F2.ok, 'host and bidders can log in');
    ok((await api('/api/host/loadDemo', {}, F1.token)).ok === false, 'bidder cannot use host actions');

    console.log('Purse accounting');
    ok((await api('/api/host/loadDemo', {}, H.token)).ok, 'sample data loads');
    await api('/api/host/settings', { auctionMode: 'watch', stage: 'auction', timerSeconds: 8, bidResetSeconds: 3, reservePerSlot: 0 }, H.token);
    const host = client(H.token), a = client(F1.token), b = client(F2.token), spec = client('');
    await Promise.all([host.ready, a.ready, b.ready, spec.ready]); await sleep(300);
    const team = (c, id) => c.state.teams.find((t) => t.id === id);
    const isu = team(a, 'isu'), kk = team(a, 'kk');
    ok(isu.directSpend === 6.3 * CR && isu.extension === 5.5 * CR, 'ISU direct signing 6.3 Cr gets the 5.5 Cr top-up');
    ok(Math.round(isu.remaining) === Math.round((45 + 5.5 - 6.3 - 1.2) * CR), 'ISU purse = 45 + 5.5 - 6.3 - 1.2 retention = 43.0 Cr');
    ok(Math.round(kk.remaining) === Math.round((45 + 5.5 - 6.4 - 3.76 - 3.06 - 3.38 - 0.6) * CR), 'KK purse correct after 1 direct + 4 retentions');
    ok(team(a, 'ms').remaining === 45 * CR, 'MS (no signings) keeps 45 Cr');
    ok(spec.state.me === null && !spec.state.admin, 'spectator gets no private data');
    ok(!!host.state.admin && host.state.admin.users.length === 9, 'host receives the user list');

    console.log('Live bidding');
    ok((await api('/api/host/auctionNext', {}, H.token)).ok, 'host presses Next player');
    await sleep(200);
    const A = () => a.state.auction;
    ok(A().status === 'live' && !!A().playerId, 'all clients see the lot live');
    const pl = a.players.find((p) => p.id === A().playerId);
    ok(spec.state.auction.playerId === A().playerId, 'spectator sees the same player');
    let r = await a.send({ type: 'bid', steps: 1, expect: A().nextAmount });
    ok(r.ok && A().currentBid === pl.basePrice, `opening bid is the base price (${pl.basePrice / CR} Cr)`);
    r = await a.send({ type: 'bid', steps: 1 });
    ok(!r.ok, 'same team cannot outbid itself');
    r = await spec.send({ type: 'bid', steps: 1 });
    ok(!r.ok, 'spectator cannot bid');
    r = await b.send({ type: 'bid', steps: 1 });
    const incExpected = pl.basePrice < 1.1 * CR ? 0.025 * CR : pl.basePrice < 2.2 * CR ? 0.05 * CR : pl.basePrice < 4.2 * CR ? 0.1 * CR : 0.15 * CR;
    ok(r.ok && Math.round(A().currentBid - pl.basePrice) === Math.round(incExpected), `increment from ${pl.basePrice / CR} Cr is ${incExpected / CR} Cr`);
    ok(A().leaderTeamId === 'kk' || A().leaderTeamId === b.state.me.teamId, 'leader updates');
    r = await a.send({ type: 'bid', steps: 1, expect: 1 });
    ok(!r.ok, 'stale price is rejected');
    r = await a.send({ type: 'bid', steps: 3 });
    ok(r.ok && A().history.at(-1).golden === true, 'Golden Paddle jumps 3 steps');
    r = await b.send({ type: 'bid', steps: 2 });
    ok(r.ok, 'second team uses its own Golden Paddle');
    r = await a.send({ type: 'bid', steps: 2 });
    ok(!r.ok && /Golden Paddle/.test(r.error), 'a team cannot use a second Golden Paddle');
    const before = A().currentBid;
    ok((await api('/api/host/auctionUndoBid', {}, H.token)).ok && A().currentBid < before, 'host can undo the last bid');

    console.log('Tight-purse limit');
    await api('/api/host/settings', { reservePerSlot: 0.6 * CR }, H.token);
    await sleep(100);
    const stat = team(a, 'isu');
    ok(stat.maxBid < stat.remaining, 'max bid keeps money back for the minimum squad');

    console.log('Sold');
    const leader = A().leaderTeamId, price = A().currentBid;
    const beforeRem = team(a, leader).remaining;
    ok((await api('/api/host/auctionSold', {}, H.token)).ok, 'host marks Sold');
    await sleep(200);
    ok(A().status === 'sold' && A().result.price === price, 'result is broadcast');
    ok(Math.round(beforeRem - team(a, leader).remaining) === price, 'winning price is deducted from the purse');
    ok(a.players.find((p) => p.id === pl.id).status === 'sold', 'player status becomes sold');

    console.log('Auto-finalise and unsold');
    ok((await api('/api/host/auctionNext', {}, H.token)).ok, 'next lot starts');
    await sleep(8800);
    ok(A().status === 'unsold', 'no bids: timer end marks the player unsold automatically');
    ok((await api('/api/host/auctionNext', {}, H.token)).ok, 'third lot starts');
    await a.send({ type: 'bid', steps: 1 });
    await sleep(500);
    await api('/api/host/auctionPause', {}, H.token); await sleep(200);
    ok(A().status === 'paused', 'pause works');
    r = await b.send({ type: 'bid', steps: 1 });
    ok(!r.ok, 'bids rejected while paused');
    await api('/api/host/auctionResume', {}, H.token);
    await sleep(8500 + 3200);
    ok(A().status === 'sold', 'single bidder wins when the timer ends');

    console.log('Signings from host console');
    r = await api('/api/host/signingAdd', { kind: 'retained', teamId: 'ms', name: 'Test Player', country: 'pk', role: 'Batter', price: 2 * CR }, H.token);
    await sleep(150);
    ok(r.ok && team(a, 'ms').remaining === 43 * CR, 'new retention deducts 2 Cr from MS');
    r = await api('/api/host/signingAdd', { kind: 'direct', teamId: 'ms', name: 'Direct Guy', country: 'au', role: 'Bowler', price: 8 * CR }, H.token);
    await sleep(150);
    ok(r.ok && team(a, 'ms').extension === 5.5 * CR && team(a, 'ms').remaining === 43 * CR + 5.5 * CR - 8 * CR, 'direct signing adds the purse top-up (capped at 5.5 Cr)');

    console.log('Import');
    r = await api('/api/host/playersImport', { mode: 'append', players: [{ name: 'Imported One', country: 'nz', basePrice: 1.1 * CR }] }, H.token);
    ok(r.ok && r.added === 1, 'player import works');
    ok((await fetch(BASE + '/flags/pk.svg')).status === 200, 'flag SVGs are served');
    ok((await fetch(BASE + '/')).status === 200, 'front page is served');
  } catch (e) { console.error(e); failed++; }
  srv.kill();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();
