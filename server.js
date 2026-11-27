'use strict';
/**
 * Tertiary Tech presents PSL (Pakistan Superior League) - Live Mock Auction Server
 * Express (REST + static) + ws (real time). State lives in memory and is saved to data/state.json.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CRED_FILE = path.join(DATA_DIR, 'credentials.txt');
const CR = 10_000_000; // 1 crore rupees
const cr = (x) => Math.round(x * CR);

// ---------------------------------------------------------------- defaults
const TEAM_DEFS = [
  ['isu', 'Islamabad United', 'ISU', '#e5202e'],
  ['kk', 'Karachi Kings', 'KK', '#2f6fed'],
  ['lq', 'Lahore Qalandars', 'LQ', '#22c55e'],
  ['ms', 'Multan Sultans', 'MS', '#06b6d4'],
  ['pz', 'Peshawar Zalmi', 'PZ', '#facc15'],
  ['qg', 'Quetta Gladiators', 'QG', '#a855f7'],
  ['hyd', 'Hyderabad Houston Kingsmen', 'HYD', '#f97316'],
  ['skt', 'Sialkot Stallionz', 'SKT', '#14b8a6'],
];

const ROLES = ['Batter', 'Bowler', 'All-rounder', 'WK-Batter'];
const CATEGORIES = ['Platinum', 'Diamond', 'Gold', 'Silver', 'Emerging'];

function defaultSettings() {
  return {
    leagueName: 'Tertiary Tech presents PSL',
    leagueSub: 'Pakistan Superior League',
    stage: 'direct', // direct | retention | auction  (where the train is)
    auctionMode: 'coming_soon', // coming_soon | register | watch
    auctionDate: '', // free text or ISO datetime
    venue: 'Gaddafi Stadium, Lahore',
    pursePkr: cr(45),
    directExtension: cr(5.5),
    maxDirect: 1,
    maxRetention: 4,
    minSquad: 16,
    maxSquad: 20,
    maxOverseas: 7,
    reservePerSlot: cr(0.6), // purse kept back for each unfilled minimum-squad slot (0 = off)
    goldenPaddles: 1,
    timerSeconds: 30,
    bidResetSeconds: 10,
    autoFinalize: true,
    basePriceTiers: [cr(0.6), cr(1.1), cr(2.2), cr(4.2)],
    slabs: [
      { upto: cr(1.1), inc: cr(0.025) },
      { upto: cr(2.2), inc: cr(0.05) },
      { upto: cr(4.2), inc: cr(0.1) },
      { upto: null, inc: cr(0.15) },
    ],
  };
}

function randPass(n = 6) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

function freshAuction() {
  return {
    status: 'idle', // idle | live | paused | sold | unsold
    playerId: null,
    currentBid: 0,
    leaderTeamId: null,
    history: [],
    passed: [],
    durationMs: 30000,
    timerEndsAt: 0,
    remainingMs: 0,
    timeUp: false,
    result: null,
    lotNo: 0,
    event: { seq: 0, type: 'none' },
    log: [], // finished lots: {lotNo, playerId, type, teamId, price, at}
  };
}

function freshState() {
  const teams = TEAM_DEFS.map(([id, name, short, color]) => ({ id, name, short, color, paddlesUsed: 0 }));
  // Passwords come from environment variables when set (HOST_PASSWORD, FRIEND1_PASSWORD ... FRIEND8_PASSWORD),
  // so they stay the same even if the host machine restarts and loses its disk.
  const users = [{ id: 'u_host', username: 'host', password: process.env.HOST_PASSWORD || randPass(8), displayName: 'Host', role: 'host', teamId: null }];
  teams.forEach((t, i) =>
    users.push({
      id: 'u_' + (i + 1),
      username: 'friend' + (i + 1),
      password: process.env['FRIEND' + (i + 1) + '_PASSWORD'] || randPass(6),
      displayName: 'Friend ' + (i + 1),
      role: 'bidder',
      teamId: t.id,
    })
  );
  return {
    settings: defaultSettings(),
    teams,
    users,
    players: [],
    auction: freshAuction(),
    registrations: [],
    sessions: {},
    seq: 1,
    pv: 1, // players version
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------- state load / save
let state;

// Optional remote store (Upstash Redis, free tier). Hosts with a temporary disk, like Render's free plan, lose
// data/state.json on every restart. With UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN set, the whole
// state (players, signings, results, logins, sessions) is also saved there and reloaded on start.
const REMOTE_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE_KEY = process.env.REMOTE_STATE_KEY || 'psl-auction-state';
const remoteOn = !!(REMOTE_URL && REMOTE_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function remoteCmd(cmd) {
  const r = await fetch(REMOTE_URL.replace(/\/+$/, ''), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.result;
}
const pack = (obj) => zlib.gzipSync(JSON.stringify(obj)).toString('base64');
const unpack = (s) => JSON.parse(zlib.gunzipSync(Buffer.from(s, 'base64')).toString('utf8'));
let lastRemote = '', remoteTimer = null, remoteBusy = false, remoteDirty = false;
function scheduleRemote() {
  if (!remoteOn) return;
  remoteDirty = true;
  if (!remoteTimer && !remoteBusy) remoteTimer = setTimeout(flushRemote, 1500);
}
async function flushRemote() {
  clearTimeout(remoteTimer); remoteTimer = null;
  if (!remoteOn || remoteBusy || !remoteDirty) return;
  remoteBusy = true; remoteDirty = false;
  try {
    const packed = pack(state);
    if (packed !== lastRemote) { await remoteCmd(['SET', REMOTE_KEY, packed]); lastRemote = packed; }
  } catch (e) {
    console.error('Remote save failed (will retry):', e.message);
    remoteDirty = true;
  }
  remoteBusy = false;
  if (remoteDirty && !remoteTimer) remoteTimer = setTimeout(flushRemote, 4000);
}

async function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let fresh = false;
  let loaded = null;
  if (remoteOn) {
    // If the remote store cannot be reached we stop instead of starting blank and overwriting saved data.
    let ok = false, lastErr = null;
    for (let i = 0; i < 4 && !ok; i++) {
      try {
        const v = await remoteCmd(['GET', REMOTE_KEY]);
        if (v) { loaded = unpack(v); lastRemote = v; console.log('  Loaded saved state from the remote store.'); }
        ok = true;
      } catch (e) { lastErr = e; await sleep(1500); }
    }
    if (!ok) {
      console.error('Cannot reach the remote store (' + (lastErr && lastErr.message) + '). Stopping so saved data is not overwritten. Check the UPSTASH values.');
      process.exit(1);
    }
  }
  if (!loaded && fs.existsSync(STATE_FILE)) {
    try { loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { console.error('Could not read state.json, starting fresh:', e.message); }
  }
  if (loaded) {
    state = loaded;
    // forward compatible defaults
    state.settings = { ...defaultSettings(), ...state.settings };
    state.auction = { ...freshAuction(), ...state.auction };
    state.registrations = state.registrations || [];
    state.sessions = state.sessions || {};
    state.pv = (state.pv || 0) + 1;
  } else {
    state = freshState();
    fresh = true;
  }
  // environment passwords always win, so a restart or restored backup can never lock anyone out
  for (const u of state.users) {
    const key = u.role === 'host' ? 'HOST_PASSWORD' : u.username.toUpperCase() + '_PASSWORD';
    if (process.env[key]) u.password = process.env[key];
  }
  writeCredentials();
  persistNow();
}

function writeCredentials() {
  const lines = ['Tertiary Tech presents PSL - login credentials', '(also visible to the host in Host Console > Teams & Users)', ''];
  for (const u of state.users) {
    const team = state.teams.find((t) => t.id === u.teamId);
    lines.push(`${u.role.toUpperCase().padEnd(7)} username: ${u.username.padEnd(10)} password: ${u.password}${team ? '   team: ' + team.name : ''}`);
  }
  fs.writeFileSync(CRED_FILE, lines.join('\n') + '\n');
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
}
function persistNow() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('Save failed:', e.message);
  }
  scheduleRemote();
}

// ---------------------------------------------------------------- helpers
const S = () => state.settings;
const A = () => state.auction;
const getTeam = (id) => state.teams.find((t) => t.id === id);
const getUser = (id) => state.users.find((u) => u.id === id);
const getPlayer = (id) => state.players.find((p) => p.id === id);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clean = (s, n = 80) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);
const SIGNED = ['direct', 'retained', 'sold'];

function incAt(amount) {
  const slabs = S().slabs;
  for (const s of slabs) if (s.upto == null || amount < s.upto) return s.inc;
  return slabs[slabs.length - 1].inc;
}

function teamStats(t) {
  const mine = state.players.filter((p) => p.teamId === t.id && SIGNED.includes(p.status));
  const sum = (st) => mine.filter((p) => p.status === st).reduce((a, p) => a + (p.price || 0), 0);
  const directSpend = sum('direct');
  const retainSpend = sum('retained');
  const auctionSpend = sum('sold');
  const spent = directSpend + retainSpend + auctionSpend;
  const hasDirect = mine.some((p) => p.status === 'direct');
  const extension = hasDirect ? Math.min(S().directExtension, directSpend) : 0;
  const purseTotal = S().pursePkr + extension;
  const remaining = purseTotal - spent;
  const count = mine.length;
  const overseas = mine.filter((p) => p.country !== 'pk').length;
  const slotsToFill = Math.max(0, S().minSquad - count - 1);
  const reserve = S().reservePerSlot > 0 ? slotsToFill * S().reservePerSlot : 0;
  let maxBid = count >= S().maxSquad ? 0 : Math.max(0, remaining - reserve);
  return {
    directSpend, retainSpend, auctionSpend, spent, extension, purseTotal, remaining, count, overseas,
    maxBid, reserve,
    paddlesLeft: Math.max(0, S().goldenPaddles - (t.paddlesUsed || 0)),
    directCount: mine.filter((p) => p.status === 'direct').length,
    retainCount: mine.filter((p) => p.status === 'retained').length,
    soldCount: mine.filter((p) => p.status === 'sold').length,
  };
}

function teamViews() {
  return state.teams.map((t) => {
    const owner = state.users.find((u) => u.teamId === t.id && u.role === 'bidder');
    return { ...t, ...teamStats(t), owner: owner ? owner.displayName : null, ownerId: owner ? owner.id : null };
  });
}

function auctionView() {
  const a = A();
  const player = getPlayer(a.playerId);
  const base = player ? player.basePrice : 0;
  const nextAmount = a.currentBid ? a.currentBid + incAt(a.currentBid) : base;
  return {
    status: a.status, playerId: a.playerId, currentBid: a.currentBid, leaderTeamId: a.leaderTeamId,
    history: a.history.slice(-25), passed: a.passed, durationMs: a.durationMs, timerEndsAt: a.timerEndsAt,
    remainingMs: a.remainingMs, timeUp: a.timeUp, result: a.result, lotNo: a.lotNo, event: a.event,
    inc: a.currentBid ? incAt(a.currentBid) : incAt(base), nextAmount,
    log: a.log.slice(-60),
    queueLeft: state.players.filter((p) => p.status === 'pool' && p.id !== a.playerId).length,
    upcoming: state.players.filter((p) => p.status === 'pool' && p.id !== a.playerId).slice(0, 6).map((p) => p.id),
  };
}

function eligibility(team, player, amount) {
  const st = teamStats(team);
  if (!player) return 'No player on the block';
  if (st.count >= S().maxSquad) return `Squad full (${S().maxSquad})`;
  if (player.country !== 'pk' && st.overseas >= S().maxOverseas) return `Overseas limit reached (${S().maxOverseas})`;
  if (amount > st.remaining) return 'Not enough purse';
  if (amount > st.maxBid) return 'Must keep purse for minimum squad';
  return null;
}

// ---------------------------------------------------------------- auction engine
let lotTimer = null;
const clearLotTimer = () => { clearTimeout(lotTimer); lotTimer = null; };
function emit(type, extra = {}) {
  const a = A();
  a.event = { seq: (a.event.seq || 0) + 1, type, at: Date.now(), ...extra };
}
function scheduleTimer() {
  clearLotTimer();
  const a = A();
  if (a.status !== 'live') return;
  lotTimer = setTimeout(onTimerEnd, Math.max(0, a.timerEndsAt - Date.now()) + 30);
}
function onTimerEnd() {
  const a = A();
  if (a.status !== 'live') return;
  if (a.timerEndsAt - Date.now() > 60) return scheduleTimer();
  if (S().autoFinalize) finalizeLot();
  else { a.timeUp = true; emit('timeup'); commit(true); }
}
function finalizeLot() {
  if (A().leaderTeamId) sellLot(); else unsoldLot();
}
function startLot(player) {
  const a = A();
  a.playerId = player.id;
  a.status = 'live';
  a.currentBid = 0;
  a.leaderTeamId = null;
  a.history = [];
  a.passed = [];
  a.result = null;
  a.timeUp = false;
  a.durationMs = S().timerSeconds * 1000;
  a.timerEndsAt = Date.now() + a.durationMs;
  a.remainingMs = 0;
  a.lotNo += 1;
  emit('next', { playerId: player.id });
  scheduleTimer();
  commit(true);
}
function sellLot() {
  const a = A();
  const p = getPlayer(a.playerId);
  if (!p || !a.leaderTeamId) return;
  clearLotTimer();
  p.status = 'sold'; p.teamId = a.leaderTeamId; p.price = a.currentBid;
  a.status = 'sold';
  a.result = { type: 'sold', teamId: a.leaderTeamId, price: a.currentBid };
  a.log.push({ lotNo: a.lotNo, playerId: p.id, type: 'sold', teamId: a.leaderTeamId, price: a.currentBid, at: Date.now() });
  emit('sold', { playerId: p.id, teamId: a.leaderTeamId, price: a.currentBid });
  state.pv++;
  commit(true);
}
function unsoldLot() {
  const a = A();
  const p = getPlayer(a.playerId);
  if (!p) return;
  clearLotTimer();
  p.status = 'unsold'; p.teamId = null; p.price = 0;
  a.status = 'unsold';
  a.currentBid = 0; a.leaderTeamId = null; a.history = [];
  a.result = { type: 'unsold' };
  a.log.push({ lotNo: a.lotNo, playerId: p.id, type: 'unsold', at: Date.now() });
  emit('unsold', { playerId: p.id });
  state.pv++;
  commit(true);
}

function placeBid(teamId, { steps = 1, expect = null, byHost = false } = {}) {
  const a = A();
  const team = getTeam(teamId);
  const player = getPlayer(a.playerId);
  if (!team) return 'Unknown team';
  if (a.status !== 'live') return a.status === 'paused' ? 'Auction is paused' : 'No lot is live right now';
  if (!byHost && Date.now() > a.timerEndsAt + 150) return 'Time is up';
  if (a.leaderTeamId === teamId) return 'You already hold the highest bid';
  if (a.passed.includes(teamId)) return 'You passed on this player';
  steps = Math.max(1, Math.min(10, Math.floor(num(steps, 1))));
  let amount;
  if (!a.currentBid) {
    amount = player.basePrice;
    steps = 1; // opening bid is always at base price
  } else {
    amount = a.currentBid + steps * incAt(a.currentBid);
  }
  if (expect != null && Math.round(expect) !== amount) return 'Price just moved - check the new price and bid again';
  const stats = teamStats(team);
  if (steps > 1 && stats.paddlesLeft <= 0) return 'No Golden Paddle left';
  const why = eligibility(team, player, amount);
  if (why) return why;
  if (steps > 1) team.paddlesUsed = (team.paddlesUsed || 0) + 1;
  a.currentBid = amount;
  a.leaderTeamId = teamId;
  a.history.push({ teamId, amount, at: Date.now(), golden: steps > 1 });
  a.timeUp = false;
  const minEnd = Date.now() + S().bidResetSeconds * 1000;
  if (a.timerEndsAt < minEnd) a.timerEndsAt = minEnd;
  emit('bid', { teamId, amount, golden: steps > 1 });
  scheduleTimer();
  commit(true);
  return null;
}

// ---------------------------------------------------------------- commit / broadcast
function commit(live = false) {
  persist();
  broadcast();
}

// ---------------------------------------------------------------- web server
const app = express();
app.set('trust proxy', 1); // behind Render's proxy, so req.ip is the visitor and not the proxy
app.use(express.json({ limit: '8mb' }));
const flagsDir = (() => {
  try { return path.join(path.dirname(require.resolve('flag-icons/package.json')), 'flags', '4x3'); } catch { return null; }
})();
if (flagsDir) app.use('/flags', express.static(flagsDir, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function tokenUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  return userFromToken(token);
}
function userFromToken(token) {
  if (!token) return null;
  const uid = state.sessions[token];
  return uid ? getUser(uid) : null;
}

const loginAttempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip + '|' + String((req.body && req.body.username) || '').trim().toLowerCase();
  const rec = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 60000) { rec.n = 0; rec.t = Date.now(); }
  if (rec.n >= 12) return res.status(429).json({ ok: false, error: 'Too many attempts, wait a minute.' });
  rec.n++; loginAttempts.set(ip, rec);
  const { username, password } = req.body || {};
  const u = state.users.find((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!u || u.password !== String(password || '').trim()) return res.status(401).json({ ok: false, error: 'Wrong username or password' });
  const token = crypto.randomBytes(24).toString('hex');
  state.sessions[token] = u.id;
  persist();
  res.json({ ok: true, token, me: meView(u) });
});
app.post('/api/logout', (req, res) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) { delete state.sessions[h.slice(7)]; persist(); }
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const u = tokenUser(req);
  res.json({ ok: !!u, me: u ? meView(u) : null });
});

app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 60);
  if (!name) return res.status(400).json({ ok: false, error: 'Please enter your name' });
  if (state.registrations.length > 500) return res.status(400).json({ ok: false, error: 'Registrations are full' });
  state.registrations.push({
    id: 'r' + state.seq++, name, contact: clean(b.contact, 80), team: clean(b.team, 60), note: clean(b.note, 200), at: Date.now(),
  });
  commit();
  res.json({ ok: true });
});

app.get('/api/host/export', (req, res) => {
  const u = tokenUser(req);
  if (!u || u.role !== 'host') return res.status(403).json({ ok: false });
  res.setHeader('Content-Disposition', 'attachment; filename="psl-auction-backup.json"');
  res.json({ ...state, sessions: {} });
});

app.post('/api/host/:action', (req, res) => {
  const u = tokenUser(req);
  if (!u || u.role !== 'host') return res.status(403).json({ ok: false, error: 'Host login required' });
  const fn = actions[req.params.action];
  if (!fn) return res.status(404).json({ ok: false, error: 'Unknown action' });
  try {
    const out = fn(req.body || {}, u);
    if (typeof out === 'string') return res.json({ ok: false, error: out });
    res.json({ ok: true, ...(out || {}) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------- player helpers
function sanitizePlayer(b, existing = {}) {
  const role = ROLES.includes(b.role) ? b.role : existing.role || 'All-rounder';
  const category = CATEGORIES.includes(b.category) ? b.category : b.category === '' ? '' : existing.category || '';
  return {
    name: clean(b.name != null ? b.name : existing.name, 60),
    country: clean(b.country != null ? b.country : existing.country || 'pk', 10).toLowerCase() || 'pk',
    basePrice: Math.max(0, Math.round(num(b.basePrice, existing.basePrice || 0))),
    role, category,
  };
}
function newPlayer(b, status = 'pool') {
  const base = sanitizePlayer(b);
  if (!base.name) return null;
  return { id: 'p' + state.seq++, ...base, status, teamId: null, price: 0, origin: 'pool' };
}
function auctionBusy() {
  return ['live', 'paused'].includes(A().status);
}

// ---------------------------------------------------------------- host actions
const actions = {
  settings(b) {
    const s = S();
    const n = (k, min, max) => { if (b[k] != null) s[k] = Math.min(max, Math.max(min, Math.round(num(b[k], s[k])))); };
    ['pursePkr', 'directExtension', 'reservePerSlot'].forEach((k) => n(k, 0, 1e12));
    n('maxDirect', 0, 20); n('maxRetention', 0, 20); n('minSquad', 0, 40); n('maxSquad', 1, 40); n('maxOverseas', 0, 40);
    n('goldenPaddles', 0, 20); n('timerSeconds', 5, 600); n('bidResetSeconds', 0, 120);
    if (b.autoFinalize != null) s.autoFinalize = !!b.autoFinalize;
    if (b.stage != null && ['direct', 'retention', 'auction'].includes(b.stage)) s.stage = b.stage;
    if (b.auctionMode != null && ['coming_soon', 'register', 'watch'].includes(b.auctionMode)) s.auctionMode = b.auctionMode;
    ['leagueName', 'leagueSub', 'auctionDate', 'venue'].forEach((k) => { if (b[k] != null) s[k] = clean(b[k], 120); });
    if (Array.isArray(b.basePriceTiers)) s.basePriceTiers = b.basePriceTiers.map((x) => Math.round(num(x))).filter((x) => x > 0).slice(0, 12);
    if (Array.isArray(b.slabs) && b.slabs.length) {
      const slabs = b.slabs.map((x) => ({ upto: x.upto == null || x.upto === '' ? null : Math.round(num(x.upto)), inc: Math.max(1000, Math.round(num(x.inc))) }));
      slabs.sort((x, y) => (x.upto == null ? 1e18 : x.upto) - (y.upto == null ? 1e18 : y.upto));
      slabs[slabs.length - 1].upto = null;
      s.slabs = slabs;
    }
    commit();
  },

  teams(b) {
    for (const x of b.teams || []) {
      const t = getTeam(x.id);
      if (!t) continue;
      if (x.name != null) t.name = clean(x.name, 50) || t.name;
      if (x.short != null) t.short = clean(x.short, 5).toUpperCase() || t.short;
      if (x.color != null && /^#[0-9a-f]{6}$/i.test(x.color)) t.color = x.color;
    }
    commit();
  },

  users(b) {
    const list = b.users || [];
    const names = new Set();
    for (const x of list) {
      const u = getUser(x.id);
      if (!u) continue;
      const uname = clean(x.username, 24).toLowerCase();
      if (!uname) return 'Username cannot be empty';
      if (names.has(uname)) return 'Duplicate username: ' + uname;
      names.add(uname);
    }
    for (const x of list) {
      const u = getUser(x.id);
      if (!u) continue;
      u.username = clean(x.username, 24).toLowerCase();
      if (x.password) u.password = clean(x.password, 40);
      if (x.displayName != null) u.displayName = clean(x.displayName, 30) || u.displayName;
      if (u.role === 'bidder' && x.teamId && getTeam(x.teamId)) u.teamId = x.teamId;
    }
    // sessions of changed passwords are kept; passwords are checked at login only
    writeCredentials();
    commit();
  },

  playersImport(b) {
    const rows = Array.isArray(b.players) ? b.players : [];
    if (!rows.length) return 'No players to import';
    if (auctionBusy()) return 'Finish the live lot first';
    if (b.mode === 'replace') {
      const keep = state.players.filter((p) => SIGNED.includes(p.status) && p.status !== 'sold');
      state.players = keep;
      A().log = []; A().playerId = null; A().status = 'idle'; A().result = null; A().currentBid = 0; A().leaderTeamId = null; A().history = [];
    }
    let added = 0;
    for (const r of rows) {
      const p = newPlayer(r);
      if (p) { state.players.push(p); added++; }
    }
    state.pv++;
    commit();
    return { added };
  },

  playerAdd(b) {
    const p = newPlayer(b);
    if (!p) return 'Player name is required';
    state.players.push(p);
    state.pv++; commit();
    return { id: p.id };
  },

  playerUpdate(b) {
    const p = getPlayer(b.id);
    if (!p) return 'Player not found';
    if (p.id === A().playerId && auctionBusy()) return 'This player is on the block right now';
    Object.assign(p, sanitizePlayer(b, p));
    if (b.status && ['pool', 'unsold'].includes(b.status) && ['pool', 'unsold'].includes(p.status)) p.status = b.status;
    state.pv++; commit();
  },

  playerDelete(b) {
    const p = getPlayer(b.id);
    if (!p) return 'Player not found';
    if (p.id === A().playerId && auctionBusy()) return 'This player is on the block right now';
    if (p.status === 'sold' && !b.force) return 'Player is already sold. Use Reset Auction results first.';
    state.players = state.players.filter((x) => x.id !== p.id);
    state.pv++; commit();
  },

  playersClear() {
    if (auctionBusy()) return 'Finish the live lot first';
    state.players = state.players.filter((p) => p.status !== 'pool' && p.status !== 'unsold');
    state.pv++; commit();
  },

  playerMove(b) {
    const i = state.players.findIndex((p) => p.id === b.id);
    if (i < 0) return 'Player not found';
    const [p] = state.players.splice(i, 1);
    if (b.to === 'bottom') state.players.push(p);
    else {
      const firstPool = state.players.findIndex((x) => x.status === 'pool');
      state.players.splice(firstPool < 0 ? 0 : firstPool, 0, p);
    }
    state.pv++; commit();
  },

  playersShuffle() {
    const pool = state.players.filter((p) => p.status === 'pool');
    for (let i = pool.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    let k = 0;
    state.players = state.players.map((p) => (p.status === 'pool' ? pool[k++] : p));
    state.pv++; commit();
  },

  signingAdd(b) {
    const kind = b.kind === 'retained' ? 'retained' : 'direct';
    const team = getTeam(b.teamId);
    if (!team) return 'Choose a team';
    const price = Math.round(num(b.price, 0));
    if (price <= 0) return 'Enter the signing price';
    let p = null;
    if (b.playerId) {
      p = getPlayer(b.playerId);
      if (!p || !['pool', 'unsold'].includes(p.status)) return 'That player is not available';
    }
    const st = teamStats(team);
    const limit = kind === 'direct' ? S().maxDirect : S().maxRetention;
    const have = kind === 'direct' ? st.directCount : st.retainCount;
    if (!b.force && have >= limit) return `LIMIT: ${team.name} already has ${have} ${kind === 'direct' ? 'direct signing(s)' : 'retention(s)'} (rule: max ${limit}). Add anyway?`;
    const addedExt = kind === 'direct' && st.directCount === 0 ? Math.min(S().directExtension, price) : 0;
    if (!b.force && price > st.remaining + addedExt) return `LIMIT: price exceeds ${team.name}'s remaining purse. Add anyway?`;
    if (!p) {
      p = newPlayer({ name: b.name, country: b.country, role: b.role, category: b.category, basePrice: b.basePrice || price }, kind);
      if (!p) return 'Player name is required';
      p.origin = 'signing';
      state.players.push(p);
    } else p.status = kind;
    p.teamId = team.id; p.price = price; p.status = kind;
    state.pv++; commit();
  },

  signingUpdate(b) {
    const p = getPlayer(b.id);
    if (!p || !['direct', 'retained'].includes(p.status)) return 'Signing not found';
    if (b.teamId && getTeam(b.teamId)) p.teamId = b.teamId;
    if (b.price != null) p.price = Math.max(0, Math.round(num(b.price, p.price)));
    if (b.name != null) { Object.assign(p, sanitizePlayer(b, p)); }
    state.pv++; commit();
  },

  signingRemove(b) {
    const p = getPlayer(b.id);
    if (!p || !['direct', 'retained'].includes(p.status)) return 'Signing not found';
    if (p.origin === 'signing') state.players = state.players.filter((x) => x.id !== p.id);
    else { p.status = 'pool'; p.teamId = null; p.price = 0; }
    state.pv++; commit();
  },

  // ---- live auction controls
  auctionNext() {
    if (auctionBusy()) return 'Finish the current lot first (Sold or Unsold).';
    const p = state.players.find((x) => x.status === 'pool');
    if (!p) return 'No players left in the queue. Use "Return unsold to queue" or import more.';
    startLot(p);
  },
  auctionStart(b) {
    if (auctionBusy()) return 'Finish the current lot first (Sold or Unsold).';
    const p = getPlayer(b.playerId);
    if (!p || !['pool', 'unsold'].includes(p.status)) return 'Player not available';
    p.status = 'pool';
    startLot(p);
  },
  auctionPause() {
    const a = A();
    if (a.status !== 'live') return 'Nothing to pause';
    clearLotTimer();
    a.remainingMs = Math.max(0, a.timerEndsAt - Date.now());
    a.status = 'paused';
    emit('pause'); commit(true);
  },
  auctionResume() {
    const a = A();
    if (a.status !== 'paused') return 'Not paused';
    a.status = 'live';
    a.timerEndsAt = Date.now() + (a.remainingMs || a.durationMs);
    a.timeUp = false;
    emit('resume'); scheduleTimer(); commit(true);
  },
  auctionAddTime(b) {
    const a = A();
    const sec = Math.round(num(b.seconds, 10));
    if (a.status === 'live') { a.timerEndsAt = Math.max(Date.now() + 1000, a.timerEndsAt + sec * 1000); a.timeUp = false; scheduleTimer(); }
    else if (a.status === 'paused') a.remainingMs = Math.max(1000, a.remainingMs + sec * 1000);
    else return 'No lot is running';
    commit(true);
  },
  auctionRestartTimer() {
    const a = A();
    if (!['live', 'paused'].includes(a.status)) return 'No lot is running';
    a.durationMs = S().timerSeconds * 1000;
    if (a.status === 'live') { a.timerEndsAt = Date.now() + a.durationMs; a.timeUp = false; scheduleTimer(); }
    else a.remainingMs = a.durationMs;
    commit(true);
  },
  auctionSold() {
    const a = A();
    if (!['live', 'paused'].includes(a.status)) return 'No lot is running';
    if (!a.leaderTeamId) return 'No bids yet. Use Unsold instead.';
    sellLot();
  },
  auctionUnsold() {
    if (!['live', 'paused'].includes(A().status)) return 'No lot is running';
    unsoldLot();
  },
  auctionUndoBid() {
    const a = A();
    if (!['live', 'paused'].includes(a.status)) return 'No lot is running';
    if (!a.history.length) return 'No bids to undo';
    const last = a.history.pop();
    if (last.golden) { const t = getTeam(last.teamId); if (t && t.paddlesUsed > 0) t.paddlesUsed--; }
    const prev = a.history[a.history.length - 1];
    a.currentBid = prev ? prev.amount : 0;
    a.leaderTeamId = prev ? prev.teamId : null;
    emit('undo', { teamId: last.teamId });
    commit(true);
  },
  auctionProxyBid(b) {
    const err = placeBid(b.teamId, { steps: b.steps || 1, byHost: true });
    return err || undefined;
  },
  auctionRelease() {
    // put the current lot back in the queue (no result)
    const a = A();
    if (!['live', 'paused'].includes(a.status)) return 'No lot is running';
    if (a.history.length) return 'There are bids on this lot. Use Unsold or Sold.';
    clearLotTimer();
    a.status = 'idle'; a.playerId = null; a.result = null; a.currentBid = 0; a.leaderTeamId = null; a.history = [];
    emit('release'); commit(true);
  },
  returnUnsold() {
    let n = 0;
    state.players.forEach((p) => { if (p.status === 'unsold') { p.status = 'pool'; n++; } });
    state.pv++; commit();
    return { returned: n };
  },
  resetAuction() {
    clearLotTimer();
    state.players.forEach((p) => {
      if (p.status === 'sold' || p.status === 'unsold') { p.status = 'pool'; p.teamId = null; p.price = 0; }
    });
    state.teams.forEach((t) => (t.paddlesUsed = 0));
    state.auction = freshAuction();
    state.pv++; commit();
  },

  regDelete(b) {
    state.registrations = state.registrations.filter((r) => r.id !== b.id);
    commit();
  },

  loadDemo() {
    if (auctionBusy()) return 'Finish the live lot first';
    clearLotTimer();
    state.players = []; state.auction = freshAuction();
    state.teams.forEach((t) => (t.paddlesUsed = 0));
    const add = (name, country, role, category, basePrice, status = 'pool', teamId = null, price = 0) => {
      state.players.push({ id: 'p' + state.seq++, name, country, role, category, basePrice: cr(basePrice), status, teamId, price: cr(price), origin: status === 'pool' ? 'pool' : 'signing' });
    };
    // ILLUSTRATIVE demo values only. Replace with your own lists.
    const D = (n, c, r, cat, pr, team) => add(n, c, r, cat, pr, 'direct', team, pr);
    D('Devon Conway', 'nz', 'WK-Batter', 'Platinum', 6.3, 'isu');
    D('Moeen Ali', 'gb-eng', 'All-rounder', 'Platinum', 6.4, 'kk');
    D('Mustafizur Rahman', 'bd', 'Bowler', 'Platinum', 6.4, 'lq');
    D('Spencer Johnson', 'au', 'Bowler', 'Platinum', 5.6, 'qg');
    D('Steve Smith', 'au', 'Batter', 'Platinum', 8, 'skt');
    D('Marnus Labuschagne', 'au', 'Batter', 'Platinum', 5.5, 'hyd');
    const R = (n, c, r, cat, pr, team) => add(n, c, r, cat, pr, 'retained', team, pr);
    R('Salman Irshad', 'pk', 'Bowler', 'Gold', 1.2, 'isu');
    R('Hasan Ali', 'pk', 'Bowler', 'Diamond', 3.76, 'kk');
    R('Abbas Afridi', 'pk', 'Bowler', 'Diamond', 3.06, 'kk');
    R('Khushdil Shah', 'pk', 'All-rounder', 'Diamond', 3.38, 'kk');
    R('Saad Baig', 'pk', 'WK-Batter', 'Emerging', 0.6, 'kk');
    R('Shaheen Shah Afridi', 'pk', 'Bowler', 'Platinum', 7, 'lq');
    R('Abdullah Shafique', 'pk', 'Batter', 'Diamond', 2.2, 'lq');
    R('Sikandar Raza', 'zw', 'All-rounder', 'Gold', 2.8, 'lq');
    R('Mohammad Naeem', 'pk', 'Batter', 'Emerging', 0.7, 'lq');
    R('Usman Tariq', 'pk', 'Bowler', 'Diamond', 5.6, 'pz');
    R('Hasan Nawaz', 'pk', 'Batter', 'Gold', 3.92, 'pz');
    R('Shamyl Hussain', 'pk', 'Batter', 'Emerging', 0.84, 'pz');
    R('Saim Ayub', 'pk', 'Batter', 'Platinum', 12.6, 'hyd');
    R('Usman Khan', 'pk', 'WK-Batter', 'Gold', 4.62, 'hyd');
    R('Akif Javed', 'pk', 'Bowler', 'Silver', 1.96, 'hyd');
    R('Maaz Sadaqat', 'pk', 'Batter', 'Silver', 3.5, 'hyd');
    const P = (n, c, r, cat, pr) => add(n, c, r, cat, pr);
    P('Shadab Khan', 'pk', 'All-rounder', 'Platinum', 4.2);
    P('Mohammad Rizwan', 'pk', 'WK-Batter', 'Platinum', 4.2);
    P('Haris Rauf', 'pk', 'Bowler', 'Platinum', 4.2);
    P('Faf du Plessis', 'za', 'Batter', 'Platinum', 4.2);
    P('Rashid Khan', 'af', 'Bowler', 'Platinum', 4.2);
    P('Fakhar Zaman', 'pk', 'Batter', 'Diamond', 2.2);
    P('Naseem Shah', 'pk', 'Bowler', 'Diamond', 2.2);
    P('Imad Wasim', 'pk', 'All-rounder', 'Diamond', 2.2);
    P('Mohammad Amir', 'pk', 'Bowler', 'Diamond', 2.2);
    P('Rilee Rossouw', 'za', 'Batter', 'Diamond', 2.2);
    P('Wanindu Hasaranga', 'lk', 'All-rounder', 'Diamond', 2.2);
    P('Alex Hales', 'gb-eng', 'Batter', 'Diamond', 2.2);
    P('Kieron Pollard', 'tt', 'All-rounder', 'Gold', 1.1);
    P('Iftikhar Ahmed', 'pk', 'All-rounder', 'Gold', 1.1);
    P('Shan Masood', 'pk', 'Batter', 'Gold', 1.1);
    P('Azam Khan', 'pk', 'WK-Batter', 'Gold', 1.1);
    P('Zaman Khan', 'pk', 'Bowler', 'Gold', 1.1);
    P('Usama Mir', 'pk', 'Bowler', 'Gold', 1.1);
    P('Kusal Mendis', 'lk', 'WK-Batter', 'Gold', 1.1);
    P('Mohammad Nabi', 'af', 'All-rounder', 'Gold', 1.1);
    P('Sam Billings', 'gb-eng', 'WK-Batter', 'Gold', 1.1);
    P('Mohammad Wasim Jr', 'pk', 'Bowler', 'Silver', 0.6);
    P('Tayyab Tahir', 'pk', 'Batter', 'Silver', 0.6);
    P('Aamer Jamal', 'pk', 'All-rounder', 'Silver', 0.6);
    P('Ihsanullah', 'pk', 'Bowler', 'Emerging', 0.6);
    P('Arafat Minhas', 'pk', 'Bowler', 'Emerging', 0.6);
    P('Qasim Akram', 'pk', 'All-rounder', 'Emerging', 0.6);
    P('Haseebullah Khan', 'pk', 'WK-Batter', 'Emerging', 0.6);
    state.pv++; commit();
  },

  resetAll() {
    clearLotTimer();
    const users = state.users;
    const sessions = state.sessions;
    const settings = { ...state.settings };
    state = { ...freshState(), users, sessions, settings };
    commit();
  },

  importBackup(b) {
    if (!b.backup || !b.backup.settings || !Array.isArray(b.backup.players)) return 'Invalid backup file';
    clearLotTimer();
    const sessions = state.sessions;
    state = { ...b.backup, sessions };
    state.settings = { ...defaultSettings(), ...state.settings };
    state.auction = { ...freshAuction(), ...state.auction };
    state.pv = (state.pv || 0) + 1;
    scheduleTimer();
    writeCredentials();
    commit();
  },
};

// ---------------------------------------------------------------- websocket
function meView(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, teamId: u.teamId };
}
function adminPayload() {
  return { users: state.users, registrations: state.registrations };
}
function sendState(ws) {
  if (ws.readyState !== 1) return;
  const u = ws.userId ? getUser(ws.userId) : null;
  const msg = {
    type: 'state', serverNow: Date.now(), settings: state.settings, teams: teamViews(), auction: auctionView(),
    me: u ? meView(u) : null, online: onlineCount(),
  };
  if (ws.pv !== state.pv) { msg.players = state.players; ws.pv = state.pv; }
  if (u && u.role === 'host') msg.admin = adminPayload();
  ws.send(JSON.stringify(msg));
}
function broadcast() {
  for (const ws of wss.clients) sendState(ws);
}
function onlineCount() {
  const ids = new Set();
  let anon = 0;
  for (const ws of wss.clients) { if (ws.userId) ids.add(ws.userId); else anon++; }
  return { users: [...ids], visitors: anon };
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.pv = 0;
  ws.on('pong', () => (ws.isAlive = true));
  try {
    const url = new URL(req.url, 'http://x');
    const u = userFromToken(url.searchParams.get('token'));
    if (u) ws.userId = u.id;
  } catch {}
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'auth') {
      const u = userFromToken(m.token);
      ws.userId = u ? u.id : null;
      broadcast();
      return;
    }
    if (m.type === 'sync') return sendState(ws);
    const u = ws.userId ? getUser(ws.userId) : null;
    if (m.type === 'bid') {
      let err;
      if (!u || u.role !== 'bidder' || !u.teamId) err = 'Log in as a team owner to bid';
      else err = placeBid(u.teamId, { steps: m.steps, expect: m.expect });
      ws.send(JSON.stringify({ type: 'ack', ref: m.ref, ok: !err, error: err }));
    } else if (m.type === 'pass') {
      let err = null;
      const a = A();
      if (!u || u.role !== 'bidder' || !u.teamId) err = 'Log in as a team owner';
      else if (a.status !== 'live') err = 'No lot is live';
      else if (a.leaderTeamId === u.teamId) err = 'You hold the highest bid';
      else if (!a.passed.includes(u.teamId)) { a.passed.push(u.teamId); emit('pass', { teamId: u.teamId }); commit(true); }
      ws.send(JSON.stringify({ type: 'ack', ref: m.ref, ok: !err, error: err }));
    }
  });
  ws.on('close', () => broadcast());
  sendState(ws);
  broadcast();
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

// ---------------------------------------------------------------- start
async function shutdown() {
  persistNow();
  remoteDirty = true;
  try { await Promise.race([flushRemote(), sleep(5000)]); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

loadState().then(() => {
  scheduleTimer();
  server.listen(PORT, '0.0.0.0', () => {
    const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
    console.log('\n  Tertiary Tech presents PSL (Pakistan Superior League) - Auction server');
    console.log('  ---------------------------------------------------------------------');
    console.log(`  Local:    http://localhost:${PORT}`);
    nets.forEach((n) => console.log(`  Network:  http://${n.address}:${PORT}   <- share this with your friends on the same Wi-Fi`));
    console.log(`  Saved data: ${remoteOn ? 'remote store (survives restarts)' : 'local disk only (lost if the host wipes its disk)'}`);
    console.log('\n  Logins (also saved in data/credentials.txt):');
    state.users.forEach((u) => {
      const t = getTeam(u.teamId);
      console.log(`   ${u.role.padEnd(7)} ${u.username.padEnd(9)} ${u.password.padEnd(10)} ${t ? t.name : ''}`);
    });
    console.log('');
  });
});

module.exports = { app, server };
