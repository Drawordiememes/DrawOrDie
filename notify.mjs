// Optional hourly alerts. Turn them on by adding a secret in GitHub (see README):
//   NTFY_TOPIC           -> push notification to the free ntfy app (https://ntfy.sh)
//   DISCORD_WEBHOOK_URL  -> message in a Discord channel
// Settings (all optional):
//   NOTIFY_TAGS=animals,space   which sections can trigger an alert (default: animals)
//   NOTIFY_EMPTY=1              also send "nothing new this hour" (default: stay quiet)
//   NTFY_SERVER=https://...     use your own ntfy server
import { SPECIES_EMOJI } from './lib.mjs';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// New, not-upsetting stories in the sections we were asked to watch. Most-covered first.
export function pickForAlert(items, tags) {
  return items
    .filter((i) => i.isNew && !i.upset && i.tags.some((t) => tags.includes(t)))
    .sort((a, b) => b.sources.length - a.sources.length || Date.parse(b.published) - Date.parse(a.published));
}

export function buzzLine(items) {
  const counts = new Map();
  for (const i of items) for (const s of new Set(i.species || [])) counts.set(s, (counts.get(s) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!top.length) return '';
  return 'Buzzing: ' + top.map(([k, n]) => `${SPECIES_EMOJI[k] || '🐾'} ${k}${n > 1 ? ' ×' + n : ''}`).join(' · ');
}

export function buildAlert(picked, { tags, siteUrl, discord = false }) {
  const label = tags.length === 1 && tags[0] === 'animals' ? 'animal' : tags.join('/');
  const n = picked.length;
  const title = n
    ? `🐾 ${n} new ${label} ${n === 1 ? 'story' : 'stories'}`
    : `🐾 Nothing new in ${label} this hour`;
  const lines = [];
  const buzz = buzzLine(picked);
  if (buzz) lines.push(buzz, '');
  for (const i of picked.slice(0, 8)) {
    const extra = i.sources.length > 1 ? ` (+${i.sources.length - 1} more outlets)` : '';
    const name = i.names && i.names.length ? ` [${i.names[0]}]` : '';
    if (discord) {
      const t = clip(i.title, 110).replace(/[\[\]]/g, '');
      lines.push(`• [${t}](<${i.link}>) — ${i.source}${extra}${name}`);
    } else {
      lines.push(`• ${clip(i.title, 110)} — ${i.source}${extra}${name}`);
    }
  }
  if (n > 8) lines.push(`…and ${n - 8} more on the site`);
  if (siteUrl && discord) lines.push('', siteUrl);
  return { title, message: lines.join('\n').trim() || 'Nothing new since the last update.' };
}

export async function sendNtfy({ server, topic, title, message, click }) {
  const body = { topic, title, message, tags: ['paw_prints'], priority: 3 };
  if (click) body.click = click;
  const res = await fetch((server || 'https://ntfy.sh').replace(/\/$/, '') + '/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

export async function sendDiscord(url, content) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1990), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
}

export async function maybeNotify(items, env = process.env) {
  const topic = (env.NTFY_TOPIC || '').trim();
  const hook = (env.DISCORD_WEBHOOK_URL || '').trim();
  if (!topic && !hook) return { sent: false, reason: 'no NTFY_TOPIC or DISCORD_WEBHOOK_URL set' };

  const tags = (env.NOTIFY_TAGS || 'animals').split(',').map((s) => s.trim()).filter(Boolean);
  const picked = pickForAlert(items, tags);
  if (!picked.length && env.NOTIFY_EMPTY !== '1') return { sent: false, reason: 'nothing new' };

  const siteUrl = env.SITE_URL || '';
  const results = [];
  if (topic) {
    const a = buildAlert(picked, { tags, siteUrl });
    try { await sendNtfy({ server: env.NTFY_SERVER, topic, title: a.title, message: a.message, click: siteUrl }); results.push('ntfy'); }
    catch (e) { console.log(`::warning::ntfy alert failed: ${e.message}`); }
  }
  if (hook) {
    const a = buildAlert(picked, { tags, siteUrl, discord: true });
    try { await sendDiscord(hook, `**${a.title}**\n${a.message}`); results.push('discord'); }
    catch (e) { console.log(`::warning::Discord alert failed: ${e.message}`); }
  }
  return { sent: results.length > 0, via: results, count: picked.length };
}
