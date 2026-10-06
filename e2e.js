const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const proj = path.join(__dirname, '..');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

const DB = path.join(require('os').tmpdir(), 'drawcontest-e2e.json');
for (const f of [DB, DB + '.tmp']) { try { fs.unlinkSync(f); } catch {} }
const PORT = 3112;
const base = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  ', m); };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(p, opts = {}, token, extra = {}) {
  const r = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra } });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function login(kp) {
  const wallet = bs58.encode(kp.publicKey);
  const { body } = await call('/api/nonce');
  const sig = nacl.sign.detached(Buffer.from(body.message), kp.secretKey);
  const r = await call('/api/login', { method: 'POST', body: JSON.stringify({ wallet, nonce: body.nonce, signature: Buffer.from(sig).toString('base64') }) });
  return { wallet, token: r.body.token, status: r.status };
}

(async () => {
  const ownerKp = nacl.sign.keyPair();
  const env = { ...process.env, OWNER_WALLET: bs58.encode(ownerKp.publicKey), PORT, DB_PATH: DB, ROUND_SECONDS: '10', FEE_POLL_SECONDS: '1', FAKE_FEES: '1', FAKE_SENDER: '1', ADMIN_KEY: 'testkey123' };
  // speed up the fee poll for the test by using a tiny config override via a copy of config is overkill; poll interval is 10s so we also trigger by waiting.
  const srv = spawn('node', [proj + '/server.js'], { env, cwd: proj, stdio: 'inherit' });
  await sleep(1200);
  try {
    const a = nacl.sign.keyPair(), b = nacl.sign.keyPair(), c = nacl.sign.keyPair();
    const A = await login(a), B = await login(b), C = await login(c);
    assert(A.status === 200 && A.token, 'wallet logs in with no token requirement');

    const n = (await call('/api/nonce')).body;
    const bad = nacl.sign.detached(Buffer.from(n.message), b.secretKey);
    assert((await call('/api/login', { method: 'POST', body: JSON.stringify({ wallet: A.wallet, nonce: n.nonce, signature: Buffer.from(bad).toString('base64') }) })).status === 401, 'forged signature rejected');

    // owner can set the CA; nobody else can
    const O = await login(ownerKp);
    const GOOD = bs58.encode(nacl.sign.keyPair().publicKey);
    assert((await call('/api/owner/ca', { method: 'POST', body: JSON.stringify({ ca: GOOD }) }, A.token)).status === 403, 'non-owner cannot set the CA');
    assert((await call('/api/owner/ca', { method: 'POST', body: JSON.stringify({ ca: GOOD }) })).status === 403, 'signed-out visitor cannot set the CA');
    assert((await call('/api/owner/ca', { method: 'POST', body: JSON.stringify({ ca: 'not-an-address!' }) }, O.token)).status === 400, 'owner CA is validated');
    assert((await call('/api/owner/ca', { method: 'POST', body: JSON.stringify({ ca: GOOD }) }, O.token)).status === 200, 'owner can set the CA');
    let so = (await call('/api/state', {}, O.token)).body;
    assert(so.ca === GOOD && so.me.isOwner === true, 'state shows the CA and flags the owner');
    assert((await call('/api/state', {}, A.token)).body.me.isOwner === false, 'other wallets are not flagged as owner');
    await call('/api/owner/ca', { method: 'POST', body: JSON.stringify({ ca: '' }) }, O.token);
    assert((await call('/api/state')).body.ca === null, 'owner can clear the CA');

    const open = await call('/api/state');
    assert(open.status === 200 && open.body.me === null && open.body.round.end - open.body.round.start === 10000, 'state viewable without a wallet; round length honoured');

    const d1 = await call('/api/drawings', { method: 'POST', body: JSON.stringify({ name: 'rug', image: PNG }) }, A.token);
    const d2 = await call('/api/drawings', { method: 'POST', body: JSON.stringify({ name: 'moon', image: PNG }) }, B.token);
    assert(d1.status === 200 && d2.status === 200, 'two drawings submitted');
    assert((await call('/api/drawings', { method: 'POST', body: JSON.stringify({ name: 'x', image: PNG }) }, A.token)).status === 409, 'second drawing from same wallet rejected');
    assert((await call('/api/vote', { method: 'POST', body: JSON.stringify({ drawingId: d1.body.id }) }, A.token)).status === 200, 'A votes');
    assert((await call('/api/vote', { method: 'POST', body: JSON.stringify({ drawingId: d2.body.id }) }, A.token)).status === 409, 'A cannot vote twice');
    await call('/api/vote', { method: 'POST', body: JSON.stringify({ drawingId: d1.body.id }) }, B.token);
    await call('/api/vote', { method: 'POST', body: JSON.stringify({ drawingId: d2.body.id }) }, C.token);

    // logout kills the session
    const D = await login(nacl.sign.keyPair());
    await call('/api/logout', { method: 'POST' }, D.token);
    assert((await call('/api/vote', { method: 'POST', body: JSON.stringify({ drawingId: d1.body.id }) }, D.token)).status === 401, 'disconnect/logout invalidates the session');

    // fees accrue live (polled every second in this test)
    console.log('...waiting for fees to accrue and round 1 to close and be paid');
    let st = (await call('/api/state')).body;
    for (let i = 0; i < 20 && !(st.fees.round > 0); i++) { await sleep(500); st = (await call('/api/state')).body; }
    assert(st.fees.live && st.fees.round > 0 && st.fees.prize === Math.floor(st.fees.round * 0.15), 'fees accrue live and prize = 15% of them');

    let paid;
    for (let i = 0; i < 60; i++) { await sleep(500); st = (await call('/api/state')).body; if (st.payouts.length) { paid = st.payouts[0]; break; } }
    assert(st.round.id >= 2, 'round rolled over automatically');
    const h = st.history.find((r) => r.id === 1);
    assert(h && h.winner.name === 'rug' && h.winner.wallet === A.wallet && h.winner.votes === 2, 'round 1 winner = rug / wallet A with 2 votes');
    assert((await fetch(base + '/img/' + d2.body.id)).status === 404, 'losing drawing is deleted when the round closes');
    assert((await fetch(base + '/img/' + d1.body.id)).status === 200, 'winning drawing is kept');
    const dbc = JSON.parse(fs.readFileSync(DB, 'utf8'));
    assert(!dbc.votes.some((v) => v.round === 1), "round 1's votes are cleared");
    assert(paid && paid.wallet === A.wallet && paid.round === 1 && paid.tx.startsWith('FAKE'), 'auto-pay recorded a payout with a tx signature');
    const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
    const r1 = db.rounds.find((r) => r.id === 1);
    assert(r1.fees > 0 && paid.lamports === Math.floor(r1.fees * 0.15) && paid.lamports === h.prize, 'paid amount = 15% of the fees collected in round 1');
    assert(h.payState === 'paid' && h.tx === paid.tx && st.paidTotal === paid.lamports, 'history links the tx and totals match');

    // no double payment
    await sleep(6500);
    st = (await call('/api/state')).body;
    assert(st.payouts.filter((p) => p.round === 1).length === 1, 'round 1 paid exactly once');

    // admin
    assert((await call('/api/admin/delete', { method: 'POST', body: '{}' })).status === 401, 'admin endpoint rejects missing key');
    const cur = (await call('/api/state')).body;
    const nd = await call('/api/drawings', { method: 'POST', body: JSON.stringify({ name: 'bad', image: PNG }) }, B.token);
    const del = await call('/api/admin/delete', { method: 'POST', body: JSON.stringify({ drawingId: nd.body.id }) }, null, { 'x-admin-key': 'testkey123' });
    assert(del.status === 200, 'admin can delete a drawing');

    console.log('\nALL PASSED');
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
