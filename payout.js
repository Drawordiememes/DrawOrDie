#!/usr/bin/env node
// Manual payout helper (only needed when auto-pay is OFF, i.e. PAYOUT_SECRET_KEY is not set).
//
//   node payout.js                        -> list closed rounds still awaiting payment
//   node payout.js --round 41             -> show what to send for round 41
//   node payout.js --round 41 --mark-paid <txSignature>   -> record it (writes data.json next to this script)
//
// To record a payout on a hosted server instead, POST to /api/admin/paid with your ADMIN_KEY:
//   curl -X POST https://YOUR-SITE/api/admin/paid -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
//        -d '{"round":41,"tx":"<txSignature>"}'
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const sol = (l) => (l / 1e9).toFixed(6);

const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const paid = new Set(d.payouts.map((p) => p.round));
const owed = d.rounds.filter((r) => r.closed && r.winner && r.prize > 0 && !paid.has(r.id));

const roundArg = flag('--round');
if (!roundArg) {
  if (!owed.length) return console.log('Nothing owed.');
  console.log('Awaiting payment:');
  for (const r of owed) console.log(`  round ${r.id}: ${sol(r.prize)} SOL -> ${r.winner.wallet} ("${r.winner.name}", ${r.winner.votes} votes)${r.payState ? '  [' + r.payState + (r.payError ? ': ' + r.payError : '') + ']' : ''}`);
  console.log('\nDetails for one: node payout.js --round N');
  process.exit(0);
}

const r = d.rounds.find((x) => x.id === Number(roundArg));
if (!r || !r.closed || !r.winner) { console.log('That round is not closed or had no winner.'); process.exit(0); }
if (paid.has(r.id)) { console.log(`Round ${r.id} is already marked paid.`); process.exit(0); }

console.log(`Round ${r.id} winner: "${r.winner.name}" with ${r.winner.votes} vote(s)`);
console.log(`Wallet: ${r.winner.wallet}`);
console.log(`Fees collected that round: ${sol(r.fees || 0)} SOL, prize: ${sol(r.prize)} SOL\n`);
if (r.payState === 'sending' || r.payState === 'failed')
  console.log(`NOTE: auto-pay state is "${r.payState}". Check ${r.winner.wallet} on Solscan before sending, in case it actually went through.\n`);

const sig = flag('--mark-paid');
if (sig) {
  r.payState = 'paid';
  d.payouts.push({ round: r.id, wallet: r.winner.wallet, lamports: r.prize, tx: sig, at: Date.now(), auto: false });
  fs.writeFileSync(DB_PATH, JSON.stringify(d));
  console.log(`Recorded as paid (https://solscan.io/tx/${sig}).`);
} else {
  console.log('Send it with:');
  console.log(`  solana transfer ${r.winner.wallet} ${sol(r.prize)} --allow-unfunded-recipient`);
  console.log(`\nThen: node payout.js --round ${r.id} --mark-paid <txSignature>`);
}
