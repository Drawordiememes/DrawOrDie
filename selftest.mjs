#!/usr/bin/env node
// Checks the parsing, tagging, grouping and alert code on sample data. No network needed.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { decodeEntities, parseFeed, splitPublisher, classify, nameCandidates, buildItems, makeId } from './lib.mjs';
import { pickForAlert, buildAlert } from './notify.mjs';
import { FEEDS } from './feeds.mjs';

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } };

t('decodes entities', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &#39;s &#x1F43E; &rsquo;'), "Tom & Jerry 's 🐾 ’");
});

t('parses RSS with CDATA, images and dates', () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[Fox cub rescued &amp; released]]></title><link>https://a.com/1?utm_source=x</link>
      <pubDate>Fri, 10 Oct 2026 06:00:00 GMT</pubDate>
      <description>&lt;p&gt;&lt;img src="https://img.a.com/fox.jpg"&gt; A cub was freed.&lt;/p&gt;</description>
      <media:thumbnail url="https://img.a.com/thumb.jpg"/></item>
    <item><title>No date here</title><link>https://a.com/2</link><enclosure url="https://img.a.com/e.png" type="image/png"/></item>
  </channel></rss>`;
  const [a, b] = parseFeed(xml);
  assert.equal(a.title, 'Fox cub rescued & released');
  assert.equal(a.ts, Date.parse('2026-10-10T06:00:00Z'));
  assert.equal(a.image, 'https://img.a.com/thumb.jpg');
  assert.match(a.summary, /A cub was freed/);
  assert.equal(b.ts, 0);
  assert.equal(b.image, 'https://img.a.com/e.png');
});

t('parses Atom entries', () => {
  const xml = `<feed><entry><title>Atom story</title><link rel="alternate" href="https://r.com/p?a=1&amp;b=2"/><updated>2026-10-10T05:00:00Z</updated><summary>Hello</summary></entry></feed>`;
  const [a] = parseFeed(xml);
  assert.equal(a.link, 'https://r.com/p?a=1&b=2');
  assert.equal(a.ts, Date.parse('2026-10-10T05:00:00Z'));
});

t('splits Google News publisher', () => {
  assert.deepEqual(splitPublisher('Raccoon escapes zoo - The Daily Post'), { title: 'Raccoon escapes zoo', publisher: 'The Daily Post' });
  assert.deepEqual(splitPublisher('Pre-historic find - what - Reuters'), { title: 'Pre-historic find - what', publisher: 'Reuters' });
});

const animals = (title, summary = '', feed = {}) => classify(title, summary, feed);

t('tags animals, rescue, species', () => {
  const c = animals('Volunteers rescue stranded dolphin on Florida beach');
  assert.ok(c.tags.includes('animals') && c.tags.includes('rescue'));
  assert.deepEqual(c.species, ['dolphin']);
});

t('does not treat sports teams as animals', () => {
  assert.equal(animals('Detroit Lions beat Chicago Bears in overtime').tags.includes('animals'), false);
  assert.equal(animals('Miami Dolphins quarterback out for the season').tags.includes('animals'), false);
  assert.equal(animals('Baltimore Ravens vs. Eagles: odds and picks').tags.includes('animals'), false);
});

t('does not treat crypto, brands or idioms as animals', () => {
  assert.equal(animals('Bitcoin whale moves $50 million').tags.includes('animals'), false);
  assert.equal(animals('Navy SEAL team honored at ceremony').tags.includes('animals'), false);
  assert.equal(animals('Fox News host announces new show').tags.includes('animals'), false);
  assert.equal(animals('Stocks slide as bear market fears grow').tags.includes('animals'), false);
  assert.equal(animals('Shark Tank investors back new startup').tags.includes('animals'), false);
});

t('real animal stories still match', () => {
  for (const s of ['Zoo welcomes baby giraffe', 'Seattle raccoon goes viral', 'Humane society says shelter is full', 'Orcas spotted off the coast', 'Bear wanders into Colorado school']) {
    assert.ok(animals(s).tags.includes('animals'), s);
  }
});

t('space tag', () => {
  assert.ok(animals('NASA delays crew launch after weather').tags.includes('space'));
  assert.ok(animals('Comet visible before dawn this weekend').tags.includes('space'));
  assert.equal(animals('Bruno Mars announces tour dates').tags.includes('space'), false);
});

t('upsetting stories are flagged', () => {
  assert.equal(animals('Dog killed in house fire').upset, true);
  assert.equal(animals('Zoo welcomes baby giraffe').upset, false);
});

t('"need" drops off-topic search results; hints add tags', () => {
  assert.equal(classify('Senate passes budget bill', '', { need: 'animals', hint: ['animals'] }), null);
  assert.ok(classify('Weekly roundup', '', { hint: ['space'] }).tags.includes('space'));
});

t('finds names', () => {
  assert.deepEqual(nameCandidates('Seattle raccoon named “Jimothy” is the internet’s new obsession'), ['Jimothy']);
  assert.deepEqual(nameCandidates('Zoo names baby hippo Pudding after online vote'), ['Pudding']);
  assert.deepEqual(nameCandidates('Baby hippo dubbed Pudding wins hearts'), ['Pudding']);
  assert.deepEqual(nameCandidates('Jimothy the raccoon takes over social media'), ['Jimothy']);
});

const NOW = Date.parse('2026-10-10T12:00:00Z');
const mins = (m) => NOW - m * 60e3;
const raw = (title, source, m, feed = { hint: ['animals'] }) => ({ title, link: 'https://x.com/' + encodeURIComponent(title), source, ts: mins(m), summary: '', image: '', feed });

t('groups the same story across outlets', () => {
  const items = buildItems([
    raw('Seattle raccoon named “Jimothy” is the internet’s new obsession', 'Post', 10),
    raw('Jimothy the raccoon is the internet’s new obsession in Seattle', 'Wire', 20),
    raw('Volunteers rescue stranded dolphin on Florida beach', 'Local', 30),
  ], NOW);
  assert.equal(items.length, 2);
  const j = items.find((i) => /Jimothy/.test(i.title));
  assert.deepEqual(j.sources.sort(), ['Post', 'Wire']);
  assert.ok(j.species.includes('raccoon'));
});

t('groups stories about the same named animal', () => {
  const items = buildItems([
    raw('Seattle raccoon named “Jimothy” is the internet’s new obsession', 'Post', 10),
    raw('Jimothy the raccoon takes over social media again', 'Wire', 25),
    raw('Zoo names baby hippo Pudding after online vote', 'A', 40),
    raw('Pudding the baby hippo meets visitors for the first time', 'B', 50),
  ], NOW);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.sources.length === 2));
});

t('drops stories older than 48h and clamps future times', () => {
  const items = buildItems([raw('Zoo welcomes baby giraffe', 'A', 60 * 49), { ...raw('Panda cub born at zoo today', 'B', 0), ts: NOW + 3600e3 }], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].published, new Date(NOW).toISOString());
});

t('marks only unseen stories as new, using the previous run', () => {
  const first = buildItems([raw('Zoo welcomes baby giraffe', 'A', 30)], NOW);
  assert.equal(first[0].isNew, true);
  const prev = { generatedAt: 'x', items: first };
  const second = buildItems([raw('Zoo welcomes baby giraffe', 'A', 90), raw('Orcas spotted off the coast', 'B', 5)], NOW + 3600e3, prev);
  assert.equal(second.find((i) => /giraffe/.test(i.title)).isNew, undefined);
  assert.equal(second.find((i) => /Orcas/.test(i.title)).isNew, true);
});

t('keeps the old time for undated stories', () => {
  const r = { ...raw('Zoo welcomes baby giraffe', 'A', 0), ts: 0 };
  const first = buildItems([r], NOW);
  const later = buildItems([r], NOW + 5 * 3600e3, { items: first });
  assert.equal(later[0].published, first[0].published);
});

t('alert picks new, non-upsetting animal stories, most outlets first', () => {
  const items = buildItems([
    raw('Seattle raccoon named “Jimothy” is the internet’s new obsession', 'Post', 10),
    raw('Jimothy the raccoon is the internet’s new obsession in Seattle', 'Wire', 12),
    raw('Volunteers rescue stranded dolphin on Florida beach', 'Local', 30),
    raw('Dog killed in house fire', 'Local', 5),
    raw('NASA delays crew launch', 'Space', 5, { hint: ['space'] }),
  ], NOW);
  const picked = pickForAlert(items, ['animals']);
  assert.equal(picked.length, 2);
  assert.match(picked[0].title, /Jimothy/);
  const a = buildAlert(picked, { tags: ['animals'], siteUrl: 'https://u.github.io/r/' });
  assert.match(a.title, /2 new animal stories/);
  assert.match(a.message, /raccoon/);
  assert.match(a.message, /\[Jimothy\]/);
  const d = buildAlert(picked, { tags: ['animals'], siteUrl: 'https://u.github.io/r/', discord: true });
  assert.match(d.message, /\(<https:\/\/x\.com\//);
});

t('same link gives the same id, tracking params ignored', () => {
  assert.equal(makeId('https://a.com/x?utm_source=1', 't'), makeId('https://a.com/x', 't'));
});

t('feed list is well formed', () => {
  assert.ok(FEEDS.length > 20);
  for (const f of FEEDS) { new URL(f.url); assert.ok(f.name); }
  assert.ok(FEEDS.some((f) => f.hint?.includes('space')) && FEEDS.some((f) => f.hint?.includes('animals')));
});

t('workflow copy matches the real workflow', () => {
  const a = '.github/workflows/update.yml', b = 'workflow-copy/update.yml';
  if (!existsSync(a) || !existsSync(b)) return;
  assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
});

// ---- the web server (used by `npm start` on hosts like Railway) ----
{
  const { createSiteServer } = await import('./serve.mjs');
  const server = createSiteServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
  const ta = async (name, fn) => { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } };
  await ta('server: serves the page, data and health check', async () => {
    assert.match((await get('/')).text, /Hourly Wire/);
    assert.equal((await get('/healthz')).status, 200);
    assert.ok(JSON.parse((await get('/data.json')).text).items.length > 0);
  });
  await ta('server: cannot read files outside site/', async () => {
    const r = await fetch(base + '/%2e%2e/package.json');
    assert.notEqual(r.status, 200);
    const sock = await new Promise((res) => {
      import('node:net').then(({ default: net }) => {
        const c = net.connect(server.address().port, '127.0.0.1', () => c.write('GET /../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
        let d = ''; c.on('data', (x) => (d += x)); c.on('close', () => res(d));
      });
    });
    assert.doesNotMatch(sock.split('\r\n')[0], /200/);
  });
  server.close();
}

console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}`);
