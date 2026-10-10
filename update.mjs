#!/usr/bin/env node
// Fetches every feed in feeds.mjs, tags and groups the stories, writes site/data.json,
// and (if configured) sends an alert. Run by GitHub Actions every hour.
//
//   node scripts/update.mjs            real run
//   node scripts/update.mjs --demo     sample data, no network (to preview the page)
import { readFile, writeFile, mkdir, appendFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FEEDS } from './feeds.mjs';
import { parseFeed, splitPublisher, buildItems, SPECIES_EMOJI } from './lib.mjs';
import { maybeNotify } from './notify.mjs';

const DEMO = process.argv.includes('--demo');
const OUT = process.env.OUT_FILE || 'site/data.json';
const PREV_FILE = process.env.PREV_FILE || 'prev.json';
const UA = 'Mozilla/5.0 (compatible; HourlyWire/1.0; +https://github.com)';

async function fetchText(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(15000), redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
    }
  }
  throw lastErr;
}

async function readFeed(feed) {
  const items = parseFeed(await fetchText(feed.url));
  if (!items.length) throw new Error('no stories found in feed');
  return items.map((it) => {
    let { title, publisher } = feed.publisherInTitle ? splitPublisher(it.title) : { title: it.title, publisher: '' };
    return {
      title, link: it.link, ts: it.ts, image: it.image, feed,
      source: publisher || feed.name,
      // Google News descriptions are just link lists, so skip them
      summary: feed.publisherInTitle ? '' : it.summary,
    };
  });
}

async function collect() {
  const raw = [];
  const sources = [];
  const queue = FEEDS.map((f, i) => [f, i]);
  const results = new Array(FEEDS.length);
  // Small pool so Google and friends don't rate-limit us
  const worker = async () => {
    while (queue.length) {
      const [feed, i] = queue.shift();
      try { results[i] = { ok: true, items: await readFeed(feed) }; }
      catch (e) { results[i] = { ok: false, error: String(e.message || e) }; }
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  FEEDS.forEach((f, i) => {
    const r = results[i];
    const label = f.url.includes('news.google.com') ? `Google News (${decodeURIComponent((f.url.match(/q=([^&]+)/) || [])[1] || '').slice(0, 50)})` : f.name;
    if (r.ok) { raw.push(...r.items); sources.push({ name: label, ok: true, count: r.items.length }); }
    else {
      sources.push({ name: label, ok: false, error: r.error, optional: f.optional || undefined });
      console.log(`::${f.optional ? 'notice' : 'warning'}::${label} failed: ${r.error}`);
    }
  });
  return { raw, sources };
}

function demoRaw(now) {
  const m = (mins) => now - mins * 60e3;
  const feed = (hint, need) => ({ hint, need });
  const mk = (title, source, mins, extra = {}) => ({ title, link: 'https://example.com/demo/' + encodeURIComponent(title), source, ts: m(mins), summary: '', image: '', feed: feed([]), ...extra });
  const raw = [
    mk('Seattle raccoon named “Jimothy” is the internet’s new obsession', 'Demo Post', 12, { feed: feed(['animals', 'funny']), summary: 'Fans are making shirts, songs and fan art for the round-bodied raccoon.' }),
    mk('Jimothy the raccoon takes over social media again', 'Demo Wire', 25, { feed: feed(['animals', 'funny']) }),
    mk('Volunteers rescue stranded dolphin on Florida beach', 'Demo Local', 31, { feed: feed(['animals', 'rescue']), summary: 'Beachgoers formed a human chain to keep the animal wet until marine biologists arrived.' }),
    mk('Zoo names baby hippo Pudding after online vote', 'Demo Wire', 44, { feed: feed(['animals']) }),
    mk('Pudding the baby hippo meets visitors for the first time', 'Demo Post', 52, { feed: feed(['animals']) }),
    mk('Shelter overcrowded: 90 dogs need homes this weekend', 'Demo Local', 38, { feed: feed(['animals', 'rescue']) }),
    mk('Petition to save last wild beavers in county passes 40,000 signatures', 'Demo Green', 75, { feed: feed(['animals', 'rescue']) }),
    mk('Capybara escapes zoo and becomes internet sensation', 'Demo Wire', 140, { feed: feed(['animals', 'funny']) }),
    mk('Dog killed in house fire as neighbors try to help', 'Demo Local', 20, { feed: feed(['animals']) }),
    mk('Man says he was just trying to walk his goose to the bank', 'Demo Odd News', 18, { feed: feed(['funny']) }),
    mk('Comet visible before dawn this weekend, astronomers say', 'Demo Space', 9, { feed: feed(['space']) }),
    mk('NASA delays crew launch after weather at the Cape', 'Demo Space', 33, { feed: feed(['space']) }),
    mk('Starship test flight set for next week', 'Demo Space', 95, { feed: feed(['space']) }),
    mk('Detroit Lions beat Chicago Bears in overtime thriller', 'Demo Sports', 15, { feed: feed([]) }),
    mk('Three-legged cat reunited with family after two years', 'Demo Good News', 60, { feed: feed(['goodnews']) }),
    mk('Bitcoin whale moves $50 million as market watches', 'Demo Crypto', 22, { feed: feed([]) }),
  ];
  const sources = [{ name: 'Demo data', ok: true, count: raw.length }];
  return { raw, sources };
}

async function loadPrev(prevFile) {
  try { return JSON.parse(await readFile(prevFile, 'utf8')); } catch { return null; }
}

// Fetches everything, writes the data file, sends alerts. Throws if every source failed
// (the existing data file is then left as it was).
export async function runUpdate({ demo = DEMO, out = OUT, prevFile = PREV_FILE } = {}) {
  const now = Date.now();
  const prev = await loadPrev(prevFile);
  const { raw, sources } = demo ? demoRaw(now) : await collect();

  if (!demo && raw.length === 0) {
    throw new Error('Every feed failed, so the existing site was left untouched.');
  }

  const items = buildItems(raw, now, prev);
  const data = {
    generatedAt: new Date(now).toISOString(),
    demo: demo || undefined,
    speciesMeta: SPECIES_EMOJI,
    sources,
    items,
  };
  await mkdir(dirname(out), { recursive: true });
  // write then rename, so a visitor never gets a half-written file
  await writeFile(out + '.tmp', JSON.stringify(data));
  await rename(out + '.tmp', out);

  const ok = sources.filter((s) => s.ok).length;
  const inHour = items.filter((i) => now - Date.parse(i.published) <= 3600e3);
  const animalsHour = inHour.filter((i) => i.tags.includes('animals')).length;
  const line = `${items.length} stories (${inHour.length} in the past hour, ${animalsHour} animal), ${ok}/${sources.length} sources OK`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const failed = sources.filter((s) => !s.ok && !s.optional).map((s) => `- ${s.name}: ${s.error}`).join('\n');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Hourly update\n${line}\n${failed ? '\nFailed sources:\n' + failed + '\n' : ''}`);
  }

  if (!demo) {
    const r = await maybeNotify(items);
    console.log(r.sent ? `Alert sent via ${r.via.join(', ')} (${r.count} stories)` : `No alert: ${r.reason}`);
  }
  return { line, data };
}

// Run directly (node scripts/update.mjs), but not when imported by the server
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runUpdate().catch((e) => { console.error(e.message || e); process.exit(1); });
}
