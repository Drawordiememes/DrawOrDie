#!/usr/bin/env node
// Always-on version for hosts like Railway: serves the site AND refreshes the stories
// every hour from inside the same process. No GitHub Actions needed.
//
//   npm start          (this is what Railway runs)
//
// Settings (set as variables on the host): NTFY_TOPIC, DISCORD_WEBHOOK_URL, NOTIFY_TAGS,
// NOTIFY_EMPTY, SITE_URL. PORT is provided by the host.
import { join } from 'node:path';
import { createSiteServer, SITE_DIR } from './serve.mjs';
import { runUpdate } from './update.mjs';

const PORT = Number(process.env.PORT) || 8080;
const DATA = join(SITE_DIR, 'data.json');
const MINUTE_OF_HOUR = 7;

let running = false;
export async function refresh() {
  if (running) return;
  running = true;
  try {
    await runUpdate({ demo: Boolean(process.env.DEMO), out: DATA, prevFile: DATA });
  } catch (e) {
    // keep serving the last good data.json and try again next hour
    console.error(`[${new Date().toISOString()}] update failed: ${e.message || e}`);
  } finally { running = false; }
}

function msUntilNextRun(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(MINUTE_OF_HOUR, 0, 0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
  return next - now;
}

function scheduleNext() {
  setTimeout(async () => { await refresh(); scheduleNext(); }, msUntilNextRun()).unref?.();
}

const server = createSiteServer(SITE_DIR);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hourly Wire listening on port ${PORT}`);
  refresh();          // fill in fresh stories right away
  scheduleNext();     // then at 7 minutes past every hour
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
