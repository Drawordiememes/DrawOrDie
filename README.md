# Draw or Die: memecoin drawing contest

Anyone can connect a Solana wallet (signature only, no transaction), draw on a canvas, and vote. Every 5 minutes the top-voted drawing wins 15% of the creator fees that arrived during that round. Payouts show up in a bar at the top of the page with a Solscan link.

No token is needed to play.

## Run it

```
npm install
npm start          # http://localhost:3000
```

## Settings (`config.json`)

| key | what it does |
|---|---|
| `roundMinutes` | Round length (5) |
| `feeShare` | Share of that round's fees the winner gets (0.15) |
| `feeWallet` | Wallet where your creator fees land. The site watches its SOL balance and counts every increase as fees for the current round. Can also be set with the `FEE_WALLET` env var |
| `maxPayoutSol` | Safety cap on any single payout |
| `maxPerIpPerRound` | Max votes and drawings per network per round (speed bump against vote farming) |
| `rpcUrl` | Solana RPC. Prefer the `RPC_URL` env var so the key isn't in the repo. The public RPC is rate-limited |

### How fees are counted

The site only sees SOL arriving in `feeWallet`. Claim your creator fees into that wallet (every round or so) and the live "fees this round" number goes up. Money leaving the wallet never reduces a prize. If a round has no entries, its fees roll into the next round.

## Paying winners

**Automatic (needed for 5-minute rounds, since that is 288 payouts a day):**
set the env var `PAYOUT_SECRET_KEY` to the base58 private key of a wallet that holds the SOL to pay out. Use a dedicated wallet holding only your creator fees. Never your main wallet. The server sends the prize when a round closes and records the signature, so the paid bar links to the real transaction. Each round is marked "sending" before the transfer, so a crash or timeout can never pay twice. If a transfer fails, the round shows as failed and nothing retries by itself. Check the wallet on Solscan first, then pay by hand.

**Manual:** leave `PAYOUT_SECRET_KEY` unset. Rounds show "awaiting payout". Run `node payout.js` to list what is owed, send it from your wallet, then record it:

```
node payout.js --round 41 --mark-paid <txSignature>
# or, on a hosted server:
curl -X POST https://YOUR-SITE/api/admin/paid -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" -d '{"round":41,"tx":"<txSignature>"}'
```

## Environment variables

Set these in your host (Railway: service → Variables). Secrets go here only, never in the repo.

| var | purpose |
|---|---|
| `DB_PATH` | Where `data.json` lives. Point it at a persistent volume (e.g. `/data/data.json`) or all data is wiped on every redeploy |
| `FEE_WALLET` | Public address of the payout wallet. The site counts SOL arriving here as fees |
| `RPC_URL` | Solana RPC (Helius/QuickNode). The public one is rate-limited |
| `PAYOUT_SECRET_KEY` | Private key of the payout wallet. Turns on automatic payouts. Use a dedicated wallet |
| `CONTRACT_ADDRESS` | Coin CA shown at the top. Survives redeploys |
| `OWNER_WALLET` | Wallet allowed to set the CA from the site (defaults to `ownerWallet` in `config.json`) |
| `ADMIN_KEY` | Enables `/api/admin/paid` and `/api/admin/delete` (send as `x-admin-key`) |

## Contract address

Either set `CONTRACT_ADDRESS`, or connect the owner wallet on the site: an OWNER bar appears where you can paste or clear the CA. Only the owner wallet can use it, and it can't touch votes or prizes. The saved CA lives in `data.json`, so it needs the volume.

## Rounds

Each round lasts `roundMinutes`. When it ends, the top-voted drawing wins, the round's votes and every other drawing are deleted, and the winner's drawing is kept. The board starts empty each round.

Remove an offensive drawing: `curl -X POST https://YOUR-SITE/api/admin/delete -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" -d '{"drawingId":12}'`

## Limits you should know about

- With no token requirement, one person can make many wallets. The per-network limit slows that down but does not stop a determined person. If votes get farmed, add a minimum SOL balance check or go back to requiring a token.
- The fee tracker counts any SOL sent to `feeWallet`, not only creator fees. Keep that wallet for fees only.
- Rounds close lazily and on a 5-second timer, so a round can end up to a few seconds late.
- Storage is a single `data.json`, fine for a modest crowd. Put it on a persistent volume.
- Check the rules on prizes and giveaways where you and your players live.

## Tests

`npm test` starts the server with short rounds, fake fees and a fake payment sender, then checks login, voting, fee counting, the 15% prize math, one-time payouts and the admin key. It does not touch the network or send real SOL.

## Putting this on GitHub

Create a private repo, then upload everything in this folder (not the zip itself). `.gitignore` already keeps `node_modules` and `data.json` out. Never commit private keys. `PAYOUT_SECRET_KEY` and `ADMIN_KEY` belong only in your host's environment variables.
