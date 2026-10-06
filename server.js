const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
if (process.env.RPC_URL) cfg.rpcUrl = process.env.RPC_URL;
if (process.env.FEE_WALLET) cfg.feeWallet = process.env.FEE_WALLET;
if (process.env.MAX_PAID_ROUNDS) cfg.maxPaidRounds = Number(process.env.MAX_PAID_ROUNDS);
// Prize promo: only the first `maxPaidRounds` rounds that earn a prize pay out (0 = no limit).
const promoUsed = (d, except) => d.rounds.filter((r) => r.closed && r.prize > 0 && r !== except).length;
const promoEnded = (d) => cfg.maxPaidRounds > 0 && promoUsed(d) >= cfg.maxPaidRounds;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');
const PORT = process.env.PORT || cfg.port || 3000;
const LAMPORTS = 1e9;
const roundMs = () => (process.env.ROUND_SECONDS ? Number(process.env.ROUND_SECONDS) * 1000 : cfg.roundMinutes * 60e3);
const prizeCap = () => Math.floor(cfg.maxPayoutSol * LAMPORTS);

/* ---------- storage ---------- */
function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { rounds: [], drawings: [], votes: [], payouts: [], nextDrawingId: 1, feeLast: null };
  }
}
function save(d) {
  fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(d));
  fs.renameSync(DB_PATH + '.tmp', DB_PATH);
}
const ipHash = (req) => crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 16);

/* ---------- rounds ---------- */
function tally(d, roundId) {
  const counts = new Map();
  for (const v of d.votes) if (v.round === roundId) counts.set(v.drawingId, (counts.get(v.drawingId) || 0) + 1);
  return counts;
}

function closeRound(d, round) {
  const counts = tally(d, round.id);
  const entries = d.drawings.filter((x) => x.round === round.id);
  entries.sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.createdAt - b.createdAt);
  const top = entries[0];
  round.closed = true;
  round.winner = top ? { drawingId: top.id, wallet: top.wallet, name: top.name, votes: counts.get(top.id) || 0 } : null;
  round.prize = round.winner ? Math.min(Math.floor((round.fees || 0) * cfg.feeShare), prizeCap()) : 0;
  if (cfg.maxPaidRounds > 0 && promoUsed(d, round) >= cfg.maxPaidRounds) round.prize = 0; // promo is over
}

// Lazily close/open rounds. Fees from a round nobody entered carry into the next one.
function currentRound(d) {
  const now = Date.now();
  let cur = d.rounds[d.rounds.length - 1];
  if (cur && !cur.closed && now >= cur.end) closeRound(d, cur);
  cur = d.rounds[d.rounds.length - 1];
  if (!cur || cur.closed) {
    const carry = cur && cur.closed && !cur.winner ? cur.fees || 0 : 0;
    cur = { id: (cur ? cur.id : 0) + 1, start: now, end: now + roundMs(), closed: false, winner: null, fees: carry, prize: 0 };
    d.rounds.push(cur);
  }
  save(d);
  return cur;
}

/* ---------- fee tracking (SOL arriving in the fee wallet) ---------- */
async function rpc(method, params) {
  const res = await fetch(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function pollFees() {
  let balance;
  if (process.env.FAKE_FEES) {
    const d0 = load();
    balance = (d0.feeLast || 0) + Math.floor((0.0004 + Math.random() * 0.002) * LAMPORTS); // dev/demo only
  } else if (cfg.feeWallet) {
    balance = (await rpc('getBalance', [cfg.feeWallet])).value;
  } else return;
  const d = load();
  const round = currentRound(d);
  if (d.feeLast != null && balance > d.feeLast) round.fees = (round.fees || 0) + (balance - d.feeLast);
  d.feeLast = balance; // only inflows count, so payouts leaving the wallet never reduce a prize
  save(d);
}

/* ---------- payouts ---------- */
let sender = null; // (toWallet, lamports) => Promise<signature>
function getSender() {
  if (sender) return sender;
  if (process.env.FAKE_SENDER) return (to, lamports) => Promise.resolve('FAKE' + crypto.randomBytes(20).toString('hex') + '-' + lamports);
  if (!process.env.PAYOUT_SECRET_KEY) return null;
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
  const kp = Keypair.fromSecretKey(bs58.decode(process.env.PAYOUT_SECRET_KEY));
  const conn = new Connection(cfg.rpcUrl, 'confirmed');
  sender = async (to, lamports) => {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports }));
    return sendAndConfirmTransaction(conn, tx, [kp]);
  };
  return sender;
}

let paying = false;
async function processPayouts() {
  if (paying) return;
  const send = getSender();
  if (!send) return;
  paying = true;
  try {
    let d = load();
    currentRound(d);
    d = load();
    const todo = d.rounds.filter((r) => r.closed && r.winner && r.prize > 0 && !r.payState && !d.payouts.some((p) => p.round === r.id));
    for (const r of todo) {
      // Mark BEFORE sending so a crash or timeout can never cause a second payment for the same round.
      let dd = load();
      const rr = dd.rounds.find((x) => x.id === r.id);
      rr.payState = 'sending';
      save(dd);
      try {
        const sig = await send(r.winner.wallet, r.prize);
        dd = load();
        const r2 = dd.rounds.find((x) => x.id === r.id);
        r2.payState = 'paid';
        dd.payouts.push({ round: r.id, wallet: r.winner.wallet, lamports: r.prize, tx: sig, at: Date.now(), auto: true });
        save(dd);
        console.log(`paid round ${r.id}: ${r.prize / LAMPORTS} SOL -> ${r.winner.wallet} (${sig})`);
      } catch (e) {
        dd = load();
        const r2 = dd.rounds.find((x) => x.id === r.id);
        r2.payState = 'failed';
        r2.payError = String(e.message || e).slice(0, 200);
        save(dd);
        console.error(`payout failed for round ${r.id}: ${r2.payError} (check the wallet on Solscan before retrying by hand)`);
      }
    }
  } finally {
    paying = false;
  }
}

/* ---------- auth (sign a message, no transaction) ---------- */
const nonces = new Map();
const sessions = new Map();
const loginMessage = (nonce) => `Sign in to ${cfg.siteName}\nNonce: ${nonce}\n(This only proves you own this wallet. It cannot move funds.)`;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces) if (v < now) nonces.delete(k);
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
}, 60e3).unref();

function authWallet(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const s = token && sessions.get(token);
  return s && s.exp > Date.now() ? s.wallet : null;
}

const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Slow down.' });
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '700kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/nonce', limit(30, 60e3), (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.set(nonce, Date.now() + 5 * 60e3);
  res.json({ nonce, message: loginMessage(nonce) });
});

app.post('/api/login', limit(20, 60e3), (req, res) => {
  try {
    const { wallet, nonce, signature } = req.body || {};
    if (!wallet || !nonce || !signature) return res.status(400).json({ error: 'Missing fields' });
    if (!nonces.has(nonce)) return res.status(400).json({ error: 'Nonce expired, try again' });
    const pub = bs58.decode(wallet);
    if (pub.length !== 32) return res.status(400).json({ error: 'Bad wallet' });
    const ok = nacl.sign.detached.verify(Buffer.from(loginMessage(nonce)), Buffer.from(signature, 'base64'), pub);
    if (!ok) return res.status(401).json({ error: 'Bad signature' });
    nonces.delete(nonce);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { wallet, exp: Date.now() + 24 * 3600e3 });
    res.json({ token, wallet });
  } catch {
    res.status(400).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) sessions.delete(h.slice(7));
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  const d = load();
  const round = currentRound(d);
  const wallet = authWallet(req);
  const counts = tally(d, round.id);
  const drawings = d.drawings
    .filter((x) => x.round === round.id)
    .map((x) => ({ id: x.id, name: x.name, wallet: x.wallet, votes: counts.get(x.id) || 0, createdAt: x.createdAt, img: `/img/${x.id}` }))
    .sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt);
  const myVote = wallet ? (d.votes.find((v) => v.round === round.id && v.wallet === wallet) || {}).drawingId || null : null;
  const myDrawing = wallet ? !!d.drawings.find((x) => x.round === round.id && x.wallet === wallet) : false;

  const paidByRound = new Map(d.payouts.map((p) => [p.round, p]));
  const winnerName = (rid) => ((d.rounds.find((r) => r.id === rid) || {}).winner || {}).name || '';
  const payouts = d.payouts.slice(-8).reverse().map((p) => ({ round: p.round, name: winnerName(p.round), wallet: p.wallet, lamports: p.lamports, tx: p.tx, at: p.at }));
  const history = d.rounds
    .filter((r) => r.closed)
    .slice(-10)
    .reverse()
    .map((r) => {
      const p = paidByRound.get(r.id);
      return { id: r.id, end: r.end, winner: r.winner, prize: r.prize || 0, payState: p ? 'paid' : r.payState || (r.winner && r.prize > 0 ? 'awaiting' : 'none'), tx: p ? p.tx : null };
    });
  const fees = round.fees || 0;
  const ended = promoEnded(d);
  res.json({
    promo: { limit: cfg.maxPaidRounds || 0, used: promoUsed(d), ended },
    siteName: cfg.siteName,
    round: { id: round.id, start: round.start, end: round.end },
    now: Date.now(),
    feeShare: cfg.feeShare,
    fees: {
      round: fees,
      prize: ended ? 0 : Math.min(Math.floor(fees * cfg.feeShare), prizeCap()),
      live: !!(cfg.feeWallet || process.env.FAKE_FEES),
      wallet: cfg.feeWallet || null,
    },
    paidTotal: d.payouts.reduce((s, p) => s + p.lamports, 0),
    payouts,
    drawings,
    me: wallet ? { wallet, myVote, myDrawing } : null,
    history,
  });
});

app.get('/img/:id', (req, res) => {
  const x = load().drawings.find((y) => y.id === Number(req.params.id));
  if (!x) return res.sendStatus(404);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(x.png, 'base64'));
});

app.post('/api/drawings', limit(10, 60e3), (req, res) => {
  const wallet = authWallet(req);
  if (!wallet) return res.status(401).json({ error: 'Connect your wallet first' });
  let { name, image } = req.body || {};
  name = String(name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Give it a name' });
  const prefix = 'data:image/png;base64,';
  if (typeof image !== 'string' || !image.startsWith(prefix)) return res.status(400).json({ error: 'Bad image' });
  const buf = Buffer.from(image.slice(prefix.length), 'base64');
  if (buf.length > cfg.maxImageBytes) return res.status(413).json({ error: 'Drawing too big' });
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(magic)) return res.status(400).json({ error: 'Not a PNG' });

  const d = load();
  const round = currentRound(d);
  if (d.drawings.some((x) => x.round === round.id && x.wallet === wallet)) return res.status(409).json({ error: 'One drawing per wallet per round' });
  const ip = ipHash(req);
  if (d.drawings.filter((x) => x.round === round.id && x.ip === ip).length >= cfg.maxPerIpPerRound)
    return res.status(429).json({ error: 'Too many drawings from your network this round' });
  const id = d.nextDrawingId++;
  d.drawings.push({ id, round: round.id, wallet, ip, name, png: buf.toString('base64'), createdAt: Date.now() });
  save(d);
  res.json({ ok: true, id });
});

app.post('/api/vote', limit(30, 60e3), (req, res) => {
  const wallet = authWallet(req);
  if (!wallet) return res.status(401).json({ error: 'Connect your wallet first' });
  const drawingId = Number((req.body || {}).drawingId);
  const d = load();
  const round = currentRound(d);
  const target = d.drawings.find((x) => x.id === drawingId && x.round === round.id);
  if (!target) return res.status(404).json({ error: 'That drawing is not in this round' });
  if (d.votes.some((v) => v.round === round.id && v.wallet === wallet)) return res.status(409).json({ error: 'You already voted this round' });
  const ip = ipHash(req);
  if (d.votes.filter((v) => v.round === round.id && v.ip === ip).length >= cfg.maxPerIpPerRound)
    return res.status(429).json({ error: 'Too many votes from your network this round' });
  d.votes.push({ round: round.id, wallet, ip, drawingId, at: Date.now() });
  save(d);
  res.json({ ok: true });
});

/* ---------- admin (set ADMIN_KEY in the environment to enable) ---------- */
function isAdmin(req) {
  const key = process.env.ADMIN_KEY;
  const given = String(req.headers['x-admin-key'] || '');
  if (!key || given.length !== key.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
}
// Record a payout you sent by hand so the site shows it with a Solscan link.
app.post('/api/admin/paid', (req, res) => {
  if (!isAdmin(req)) return res.sendStatus(401);
  const { round, tx } = req.body || {};
  const d = load();
  const r = d.rounds.find((x) => x.id === Number(round));
  if (!r || !r.winner || !tx) return res.status(400).json({ error: 'Need a closed round with a winner and a tx signature' });
  if (d.payouts.some((p) => p.round === r.id)) return res.status(409).json({ error: 'Already recorded' });
  r.payState = 'paid';
  d.payouts.push({ round: r.id, wallet: r.winner.wallet, lamports: Number(req.body.lamports) || r.prize, tx: String(tx), at: Date.now(), auto: false });
  save(d);
  res.json({ ok: true });
});
// Remove a drawing (and its votes), e.g. for offensive content.
app.post('/api/admin/delete', (req, res) => {
  if (!isAdmin(req)) return res.sendStatus(401);
  const id = Number((req.body || {}).drawingId);
  const d = load();
  d.drawings = d.drawings.filter((x) => x.id !== id);
  d.votes = d.votes.filter((v) => v.drawingId !== id);
  save(d);
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`${cfg.siteName} running on http://localhost:${PORT}`);
    console.log(`rounds: ${roundMs() / 1000}s | fee wallet: ${cfg.feeWallet || (process.env.FAKE_FEES ? '(fake fees)' : 'not set')} | auto-pay: ${getSender() ? 'ON' : 'off (manual)'}`);
  });
  const tick = () => { try { currentRound(load()); } catch {} processPayouts().catch(() => {}); };
  setInterval(tick, 5000).unref();
  setInterval(() => pollFees().catch((e) => console.error('fee poll failed:', e.message)), (Number(process.env.FEE_POLL_SECONDS) || cfg.feePollSeconds || 10) * 1000).unref();
  tick();
}
module.exports = { app, load, save, closeRound, currentRound, processPayouts };
