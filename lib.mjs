// Shared logic: parsing feeds, tagging stories, grouping duplicates, picking names.
// No dependencies. Needs Node 18+.
import { createHash } from 'node:crypto';

/* ------------------------------ text helpers ------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—',
};

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

export function cleanText(s) {
  return decodeEntities(
    decodeEntities(String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function rawTag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

function attrs(tagStr) {
  const o = {};
  for (const m of tagStr.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    o[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3]);
  }
  return o;
}

const IMG_EXT = /\.(?:jpe?g|png|webp|gif|avif)(?:\?|#|$)/i;
const IMG_JUNK = /(?:pixel|beacon|tracker|doubleclick|feedburner|spacer|1x1|logo|avatar|emoji)/i;

function goodImage(u) {
  if (!u) return '';
  let url = u.trim();
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^https:\/\//i.test(url)) return '';
  if (IMG_JUNK.test(url)) return '';
  return url;
}

function findImage(block, rawDesc) {
  for (const m of block.matchAll(/<(media:content|media:thumbnail|enclosure)\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const isImg = m[1].toLowerCase() === 'media:thumbnail' ||
      (a.type || '').startsWith('image/') || a.medium === 'image' || IMG_EXT.test(a.url || '');
    if (isImg) {
      const u = goodImage(a.url);
      if (u) return u;
    }
  }
  const html = decodeEntities(rawDesc || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const im = html.match(/<img[^>]+\bsrc=["']([^"']+)["']/i);
  return im ? goodImage(decodeEntities(im[1])) : '';
}

/* ---------------------------------- feeds ---------------------------------- */

// Reads RSS (<item>) and Atom (<entry>). Returns [{ title, link, ts, summary, image }]
export function parseFeed(xml) {
  const blocks = String(xml).match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  return blocks.map((b) => {
    const title = cleanText(rawTag(b, 'title'));
    let link = cleanText(rawTag(b, 'link'));
    if (!link) {
      const links = [...b.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
      const alt = links.find((l) => l.href && (!l.rel || l.rel === 'alternate')) || links.find((l) => l.href);
      if (alt) link = alt.href;
    }
    const dateStr = cleanText(rawTag(b, 'pubDate') || rawTag(b, 'dc:date') || rawTag(b, 'published') || rawTag(b, 'updated'));
    const ts = dateStr ? Date.parse(dateStr) || 0 : 0;
    const rawDesc = rawTag(b, 'description') || rawTag(b, 'summary') || rawTag(b, 'content:encoded') || rawTag(b, 'content');
    let summary = cleanText(rawDesc);
    if (summary.length > 220) summary = summary.slice(0, 217).replace(/\s+\S*$/, '') + '…';
    return { title, link, ts, summary, image: findImage(b, rawDesc) };
  }).filter((x) => x.title && x.link);
}

// Google News titles look like "Headline - Publisher"
export function splitPublisher(title) {
  const m = title.match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
  return m ? { title: m[1], publisher: m[2].trim() } : { title, publisher: '' };
}

/* ------------------------------ animals / species ------------------------------ */

// ambig: the word is also a sports team, brand, etc. If the headline looks like sports, ignore it.
// not: headlines that match this are not about the animal.
export const SPECIES = [
  { key: 'dog', emoji: '🐶', src: 'dogs?|pupp(?:y|ies)|pooch(?:es)?|canines?' },
  { key: 'cat', emoji: '🐱', src: 'cats?|kittens?|kitty|kitties|felines?', not: /cat stevens|cat scan|caterpillar/i },
  { key: 'raccoon', emoji: '🦝', src: 'raccoons?' },
  { key: 'capybara', emoji: '🐾', src: 'capybaras?' },
  { key: 'bear', emoji: '🐻', src: 'bears?', ambig: true,
    not: /bear (?:market|in mind|with|fruit|witness|the|responsib|down|out|resemblance|arms|hug)|bearish|(?:to|can|must|will|would|could|cannot|may|might|not)\s+bear\b/i },
  { key: 'wolf', emoji: '🐺', src: 'wolf|wolves|wolfdogs?', not: /wolf blitzer|wolf of wall|tom wolf|wolf street/i },
  { key: 'fox', emoji: '🦊', src: 'foxes|fox', not: /fox news|fox business|fox sports|20th century|megan fox|michael j\.? fox|fox corp|fox nation/i },
  { key: 'deer', emoji: '🦌', src: 'deer|fawns?' },
  { key: 'horse', emoji: '🐴', src: 'horses?|ponies|pony|foals?', not: /dark horse|trojan horse|horse race|horsepower|horse-trading|horse trading/i },
  { key: 'cow', emoji: '🐄', src: 'cows?|cattle|calves' },
  { key: 'pig', emoji: '🐷', src: 'pigs?|piglets?|boars?' },
  { key: 'sheep', emoji: '🐑', src: 'sheep|lambs?', not: /lamb chops?|rack of lamb|lamb curry|lamb of god/i },
  { key: 'goat', emoji: '🐐', src: 'goats?', not: /greatest of all time|\bG\.?O\.?A\.?T\b|lebron|messi|ronaldo|brady|jordan|nba|nfl|mlb|nhl/i },
  { key: 'chicken', emoji: '🐔', src: 'chickens?|hens?|roosters?', not: /fried chicken|chicken wings?|chicken sandwich|chicken recipe|chicken tenders?|chicken nuggets?|chick-fil-a|chicken soup/i },
  { key: 'duck', emoji: '🦆', src: 'ducks?|ducklings?|mallards?', ambig: true, not: /lame duck|oregon ducks|anaheim ducks|duck dynasty|donald duck/i },
  { key: 'goose', emoji: '🪿', src: 'geese|goose|goslings?', not: /top gun|goose island|grey goose|goose bumps|mother goose/i },
  { key: 'swan', emoji: '🦢', src: 'swans?', not: /swan lake/i },
  { key: 'owl', emoji: '🦉', src: 'owls?|owlets?', ambig: true },
  { key: 'eagle', emoji: '🦅', src: 'eagles?|eaglets?', ambig: true },
  { key: 'hawk', emoji: '🦅', src: 'hawks?|falcons?|ospreys?', ambig: true, not: /falcon (?:9|heavy)|spacex|blackhawks?|tomahawk/i },
  { key: 'parrot', emoji: '🦜', src: 'parrots?|macaws?|cockatoos?|parakeets?|budgies?|cockatiels?' },
  { key: 'penguin', emoji: '🐧', src: 'penguins?', ambig: true },
  { key: 'bird', emoji: '🐦', src: 'birds?|sparrows?|robins?|finch(?:es)?|pigeons?|doves?|crows?|ravens?|magpies?|seagulls?|gulls?|herons?|storks?|cranes?|kingfishers?|hummingbirds?|woodpeckers?|vultures?|pelicans?|albatross(?:es)?|puffins?|cormorants?',
    ambig: true, not: /construction crane|tower crane|crane (?:collapse|operator)|robin (?:williams|hood|thicke)|dove (?:soap|chocolate|campaign)/i },
  { key: 'frog', emoji: '🐸', src: 'frogs?|toads?|tadpoles?' },
  { key: 'turtle', emoji: '🐢', src: 'turtles?|tortoises?|terrapins?', not: /ninja turtles?|turtle beach|turtle neck/i },
  { key: 'snake', emoji: '🐍', src: 'snakes?|pythons?|cobras?|vipers?|anacondas?|rattlesnakes?|boa constrictors?', not: /python (?:code|script|library|3|programming|developer)|monty python/i },
  { key: 'lizard', emoji: '🦎', src: 'lizards?|geckos?|iguanas?|chameleons?|komodo dragons?|axolotls?' },
  { key: 'crocodile', emoji: '🐊', src: 'crocodiles?|alligators?|gators?|crocs?', ambig: true, not: /crocs (?:shoes|sandals|inc|stock)/i },
  { key: 'shark', emoji: '🦈', src: 'sharks?', ambig: true, not: /shark tank|loan shark|card shark/i },
  { key: 'whale', emoji: '🐋', src: 'whales?|orcas?|belugas?|humpbacks?|narwhals?',
    not: /crypto|bitcoin|ethereum|\bbtc\b|\beth\b|token|wallet|trader|investors?|memecoin|solana|dogecoin|\$\d/i },
  { key: 'dolphin', emoji: '🐬', src: 'dolphins?|porpoises?', ambig: true },
  { key: 'seal', emoji: '🦭', src: 'seals?|sea lions?|walrus(?:es)?', ambig: true,
    not: /navy seals?|seal(?:ed|s)? (?:a |the |his |her |their )?(?:deal|fate|win|victory|agreement)|seal team/i },
  { key: 'otter', emoji: '🦦', src: 'otters?' },
  { key: 'octopus', emoji: '🐙', src: 'octopus(?:es)?|octopi|squids?|cuttlefish' },
  { key: 'fish', emoji: '🐟', src: 'fish|salmon|trout|goldfish|koi|stingrays?|eels?|manta rays?',
    not: /fish (?:and|&) chips|fish sandwich|fish tacos?|fish fry|fish oil|sushi|recipe|restaurant/i },
  { key: 'bee', emoji: '🐝', src: 'bees?|bumblebees?|honeybees?|wasps?', not: /spelling bee|bee gees|bee movie/i },
  { key: 'butterfly', emoji: '🦋', src: 'butterfl(?:y|ies)|moths?|monarch butterfl(?:y|ies)' },
  { key: 'spider', emoji: '🕷️', src: 'spiders?|tarantulas?', not: /spider-?man|spider-?verse/i },
  { key: 'insect', emoji: '🐛', src: 'insects?|beetles?|caterpillars?|cicadas?|locusts?|mosquito(?:es)?|ladybugs?' },
  { key: 'monkey', emoji: '🐒', src: 'monkeys?|macaques?|baboons?|lemurs?|marmosets?|capuchins?' },
  { key: 'ape', emoji: '🦍', src: 'apes?|gorillas?|chimps?|chimpanzees?|orangutans?|bonobos?', not: /bored ape|\bBAYC\b|yacht club|nft/i },
  { key: 'elephant', emoji: '🐘', src: 'elephants?' },
  { key: 'giraffe', emoji: '🦒', src: 'giraffes?' },
  { key: 'hippo', emoji: '🦛', src: 'hippos?|hippopotam(?:us|uses|i)' },
  { key: 'rhino', emoji: '🦏', src: 'rhinos?|rhinoceros(?:es)?' },
  { key: 'lion', emoji: '🦁', src: 'lions?|lionesses?', ambig: true, not: /lion king|lionsgate/i },
  { key: 'tiger', emoji: '🐯', src: 'tigers?', ambig: true, not: /tiger woods/i },
  { key: 'bigcat', emoji: '🐆', src: 'leopards?|cheetahs?|jaguars?|panthers?|cougars?|pumas?|lynx(?:es)?|bobcats?', ambig: true, not: /puma (?:shoes|sneakers|inc)/i },
  { key: 'panda', emoji: '🐼', src: 'pandas?', not: /pandas (?:dataframe|library|python)/i },
  { key: 'koala', emoji: '🐨', src: 'koalas?' },
  { key: 'kangaroo', emoji: '🦘', src: 'kangaroos?|wallab(?:y|ies)|wombats?|tasmanian devils?|quokkas?|platypus(?:es)?' },
  { key: 'sloth', emoji: '🦥', src: 'sloths?' },
  { key: 'hedgehog', emoji: '🦔', src: 'hedgehogs?' },
  { key: 'squirrel', emoji: '🐿️', src: 'squirrels?|chipmunks?' },
  { key: 'rabbit', emoji: '🐰', src: 'rabbits?|bunny|bunnies|hares?' },
  { key: 'rodent', emoji: '🐭', src: 'mice|mouse|rats?|hamsters?|guinea pigs?|gerbils?|beavers?|porcupines?|rodents?', ambig: true,
    not: /computer mouse|gaming mouse|mouse (?:pad|click|cursor)|mickey mouse|minnie mouse|mighty mouse|rat race|rat pack/i },
  { key: 'bat', emoji: '🦇', src: 'fruit bats?|vampire bats?|horseshoe bats?|bat colon(?:y|ies)|bats roosting' },
  { key: 'moose', emoji: '🦬', src: 'moose|elk|bison|buffalo|caribou|reindeer', ambig: true,
    not: /buffalo (?:bills|sabres|wild wings|ny|new york|mayor|police|city)|buffalo,? n\.?y/i },
  { key: 'camel', emoji: '🐪', src: 'camels?|llamas?|alpacas?|dromedar(?:y|ies)' },
  { key: 'donkey', emoji: '🐴', src: 'donkeys?|mules?|burros?', not: /drug mules?|money mules?/i },
  { key: 'flamingo', emoji: '🦩', src: 'flamingos?' },
  { key: 'turkey', emoji: '🦃', src: 'turkeys?', not: /\bin turkey\b|turkey's|turkish|erdogan|ankara|istanbul|türkiye/i },
].map((s) => ({ ...s, rx: new RegExp(`\\b(?:${s.src})\\b`, 'i') }));

export const SPECIES_EMOJI = Object.fromEntries(SPECIES.map((s) => [s.key, s.emoji]));
const ALL_SPECIES_SRC = SPECIES.map((s) => s.src).join('|');

const SPORTS_RX = /\b(nfl|nba|mlb|nhl|mls|ncaa|playoffs?|postseason|quarterback|touchdown|super bowl|world series|stanley cup|head coach|halftime|preseason|innings?|pitcher|linebacker|wide receiver|running back|free agent|roster|standings|power rankings?|odds|betting|spread|fantasy|vs\.?|beats?|defeats?|rout|score[sd]?|wins?|loses?|game \d)\b/i;

// Words that mean "animals" without naming one
const ANIMAL_GENERIC_RX = /\b(animals?|wildlife|zoos?|aquarium|aquariums|pets?|sanctuary|species|endangered|conservation|veterinar\w+|livestock|strays?|paws?|cubs?|hatchlings?|hatched|humane society|spca|aspca|animal shelter|pet shelter|dog shelter|cat shelter|rescue (?:group|centre|center|league|dog|cat)|critters?|fauna|marine life|sea creatures?|zookeepers?)\b/i;

const RESCUE_RX = /\b(rescue[sd]?|rescuers?|rescuing|saved|saves|saving|save the|help save|stranded|trapped|freed|frees|rehabilitat\w+|sanctuary|adopt(?:ed|ion|ions|able)?|foster\w*|overcrowded|abandoned|neglected|seized|petition|plea|reunited|released back|set free|reintroduc\w+|clear the shelters|urgent(?:ly)? need\w*|campaign to save)\b/i;

const FUNNY_RX = /\b(funny|hilarious|hilariously|bizarre|bizarrely|weird|strange|odd|quirky|comical|prank|silly|absurd|unexpected|unusual|lol|meme|memes|viral|caught on camera|steals?|stole|photobomb\w*|unhinged|chaos|oops|whoops|baffling|zany|wacky|cheeky|adorable|hilarity|laugh\w*)\b/i;

const GOOD_RX = /\b(heartwarming|heart-warming|reunited|reunion|adopted|miracle|hero|heroes|saved|rescued|returns? home|happy ending|wholesome|uplifting|kindness|touching|survives?|survived|rare birth|first-ever birth|newborn|born)\b/i;

const SPACE_RX = /\b(nasa|spacex|space station|iss|rockets?|rocket launch|launch window|liftoff|satellites?|astronauts?|cosmonauts?|asteroids?|comets?|meteors?|meteorites?|meteor shower|eclipses?|moon|lunar|mars|martian|jupiter|saturn|venus|telescope|webb|jwst|hubble|galax(?:y|ies)|nebula|exoplanets?|black holes?|supernova|solar flares?|aurora|geomagnetic|starship|starlink|artemis|esa|jaxa|isro|outer space|deep space|space (?:agency|force|telescope|probe|mission|race|flight|walk|weather|shuttle)|northern lights|planets?|cosmos|cosmic)\b/i;
const SPACE_NOT = /bruno mars|mars wrigley|mars inc|moon knight|moonlight|moonshot|blue moon/i;

const UPSET_RX = /\b(kill(?:s|ed|ing)?|dead|dies|died|death|deaths|euthaniz\w+|euthanasia|put down|shot dead|shooting|slaughter\w*|abus(?:e|ed|es|ing)|cruelty|tortur\w+|maul(?:ed|ing)?|attack(?:s|ed)?|fatal(?:ly)?|corpse|carcass(?:es)?|poison\w*|starv\w+|hoard\w*|dogfight\w*|poach\w*|massacre|bird flu|avian flu|culled?|mutilat\w+|bodies|remains found)\b/i;

function speciesIn(text) {
  const out = [];
  const sporty = SPORTS_RX.test(text);
  for (const s of SPECIES) {
    if (!s.rx.test(text)) continue;
    if (s.not && s.not.test(text)) continue;
    if (s.ambig && sporty) continue;
    out.push(s.key);
  }
  return out;
}

// Returns null if the feed's "need" tag isn't confirmed by the text (drops off-topic search results).
export function classify(title, summary, feed = {}) {
  const hint = feed.hint || [];
  const text = `${title}. ${summary || ''}`;
  const inTitle = speciesIn(title);
  const inText = speciesIn(text);
  const genericTitle = ANIMAL_GENERIC_RX.test(title);
  const genericSummary = ANIMAL_GENERIC_RX.test(summary || '');

  const detected = new Set();
  const animals = inTitle.length > 0 || genericTitle || (inText.length > 0 && genericSummary);
  if (animals) detected.add('animals');
  if (!SPACE_NOT.test(text) && SPACE_RX.test(text)) detected.add('space');
  if (feed.need && !detected.has(feed.need)) return null;

  const tags = new Set([...detected, ...hint]);
  const isAnimal = tags.has('animals');
  if (isAnimal && RESCUE_RX.test(text)) tags.add('rescue');
  if (FUNNY_RX.test(title)) tags.add('funny');
  if (isAnimal && GOOD_RX.test(text)) tags.add('goodnews');
  if (tags.has('rescue') && !isAnimal && !hint.includes('rescue')) tags.delete('rescue');

  const species = isAnimal ? (inTitle.length ? inTitle : inText.slice(0, 2)) : [];
  return { tags: [...tags], species, upset: UPSET_RX.test(title) };
}

/* ----------------------------------- names ----------------------------------- */

const NAME = "[A-Z][\\w'’-]{1,20}(?: [A-Z][\\w'’-]{1,20})?";
const NAME_BLOCK = new Set(['the', 'this', 'that', 'police', 'zoo', 'park', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'video', 'watch', 'news', 'internet', 'viral', 'twitter', 'reddit', 'tiktok',
  'instagram', 'facebook', 'google', 'nasa', 'spacex']);

// Pulls names out of patterns like: named "Jimothy", dubbed Pudding, Jimothy the raccoon
export function nameCandidates(title) {
  const out = new Set();
  const pats = [
    new RegExp(`["“‘]\\s*(${NAME})\\s*["”’]`, 'g'),
    new RegExp(`\\b(?:[Nn]amed|[Dd]ubbed|[Nn]icknamed|[Cc]alled)\\s+(${NAME})`, 'g'),
    new RegExp(`(?:^|[:,;–—-]\\s*)(${NAME}),?\\s+the\\s+(?:[a-z-]+\\s+){0,2}(?:${ALL_SPECIES_SRC})\\b`, 'g'),
    // "Zoo names baby hippo Pudding"
    new RegExp(`\\b[Nn]ames?\\s+(?:the\\s+)?(?:[a-z-]+\\s+){0,3}(?:${ALL_SPECIES_SRC})\\s+(${NAME})`, 'g'),
  ];
  for (const rx of pats) {
    for (const m of title.matchAll(rx)) {
      const n = m[1].trim();
      const words = n.toLowerCase().split(/\s+/);
      if (n.length < 3 || words.every((w) => NAME_BLOCK.has(w))) continue;
      out.add(n);
    }
  }
  return [...out].slice(0, 3);
}

/* -------------------------- grouping the same story -------------------------- */

const TOK_STOP = new Set(['with', 'from', 'that', 'this', 'have', 'after', 'about', 'their', 'into', 'over', 'says',
  'said', 'will', 'what', 'when', 'where', 'while', 'been', 'were', 'more', 'than', 'they', 'them', 'your', 'news']);

function sigTokens(title) {
  return new Set((title.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !TOK_STOP.has(w)));
}

export function normalizeLink(link) {
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ocid|cmp|ref)/i.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch { return link; }
}

export function makeId(link, title) {
  return createHash('sha1').update(normalizeLink(link) || title).digest('hex').slice(0, 12);
}

// items: newest first. Merges same-link or near-identical headlines from different outlets.
export function clusterItems(items) {
  const clusters = [];
  for (const it of items) {
    const toks = sigTokens(it.title);
    const nl = normalizeLink(it.link);
    let hit = null;
    for (const c of clusters) {
      if (c.nlink === nl) { hit = c; break; }
      // same named animal ("Jimothy") = same story, even if the headlines are worded differently
      if (it.names.length && c.names.some((n) => it.names.includes(n))) { hit = c; break; }
      let inter = 0;
      for (const t of toks) if (c.toks.has(t)) inter++;
      const uni = toks.size + c.toks.size - inter || 1;
      if (inter >= 3 && inter / uni >= 0.5) { hit = c; break; }
    }
    if (hit) {
      for (const s of it.sources) if (!hit.sources.includes(s)) hit.sources.push(s);
      hit.tags = [...new Set([...hit.tags, ...it.tags])];
      hit.species = [...new Set([...hit.species, ...it.species])];
      hit.names = [...new Set([...hit.names, ...it.names])].slice(0, 3);
      hit.upset = hit.upset || it.upset;
      if (!hit.summary && it.summary) hit.summary = it.summary;
      if (!hit.image && it.image) hit.image = it.image;
    } else {
      clusters.push({ ...it, sources: [...it.sources], toks, nlink: nl });
    }
  }
  return clusters.map(({ toks, nlink, ...rest }) => rest);
}

/* ------------------------------ raw -> final items ------------------------------ */

const KEEP_MS = 48 * 3600e3;
const MAX_ITEMS = 500;

// raw: [{ title, link, source, ts, summary, image, feed }]
// prev: previous data.json (or null). Returns final items, newest first.
export function buildItems(raw, now, prev = null) {
  const prevPub = new Map();
  const prevIds = new Set();
  if (prev && Array.isArray(prev.items) && !prev.demo) {
    for (const p of prev.items) { prevIds.add(p.id); prevPub.set(p.id, p.published); }
  }

  const staged = [];
  for (const r of raw) {
    const c = classify(r.title, r.summary, r.feed);
    if (!c) continue;
    const id = makeId(r.link, r.title);
    let ts = r.ts;
    let approx = false;
    if (!ts) {
      approx = true;
      ts = prevPub.has(id) ? Date.parse(prevPub.get(id)) : now;
    }
    if (ts > now + 10 * 60e3) ts = now; // clock skew / future-dated
    if (now - ts > KEEP_MS) continue;
    staged.push({
      id, title: r.title, link: r.link, source: r.source, sources: [r.source],
      ts, approx, summary: r.summary || '', image: r.image || '',
      tags: c.tags, species: c.species, upset: c.upset, names: c.tags.includes('animals') ? nameCandidates(r.title) : [],
    });
  }
  staged.sort((a, b) => b.ts - a.ts);

  const merged = clusterItems(staged).slice(0, MAX_ITEMS);
  return merged.map((m) => {
    const ageMin = (now - m.ts) / 60e3;
    const isNew = prev && !prev.demo ? !prevIds.has(m.id) && ageMin <= 180 : ageMin <= 70;
    return {
      id: m.id, title: m.title, link: m.link, source: m.sources[0], sources: m.sources,
      published: new Date(m.ts).toISOString(), approxTime: m.approx || undefined,
      summary: m.summary, image: m.image || undefined,
      tags: m.tags, species: m.species, names: m.names, upset: m.upset || undefined, isNew: isNew || undefined,
    };
  });
}
