// The list of places the site reads from. Edit this file to add or remove sources.
//
// Each feed:
//   name   - label shown on the page (Google News items show the real publisher instead)
//   url    - any RSS or Atom feed
//   hint   - tags to add to everything from this feed: animals, rescue, funny, space, goodnews
//   need   - for search feeds: drop results the text doesn't confirm are about this tag (animals, space)
//   publisherInTitle - Google News style "Headline - Publisher" titles
//   optional - true for sites that often block cloud servers (a failure is just logged)

const gnUrl = (query, when) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${when}`)}&hl=en-US&gl=US&ceid=US:en`;

// Each search runs twice: the last hour (so nothing new is missed) and the last day (for a fuller picture).
function googleSearch(query, opts = {}) {
  return ['1h', '1d'].map((when) => ({
    name: 'Google News', url: gnUrl(query, when), publisherInTitle: true, ...opts,
  }));
}

export const FEEDS = [
  // ---- animals, rescues, saving them ----
  ...googleSearch('animal rescue', { hint: ['animals', 'rescue'], need: 'animals' }),
  ...googleSearch('rescued dog OR rescued cat OR rescued puppy OR rescued kitten', { hint: ['animals', 'rescue'], need: 'animals' }),
  ...googleSearch('wildlife rescue OR "wildlife rehabilitation" OR "rescued wildlife"', { hint: ['animals', 'rescue'], need: 'animals' }),
  ...googleSearch('stranded whale OR dolphin OR "sea turtle" OR seal rescued', { hint: ['animals', 'rescue'], need: 'animals' }),
  ...googleSearch('animal shelter overcrowded OR "needs adopters" OR "save the animals"', { hint: ['animals', 'rescue'], need: 'animals' }),
  ...googleSearch('petition to save animals OR "campaign to save" animals OR endangered species', { hint: ['animals'], need: 'animals' }),
  ...googleSearch('zoo OR aquarium baby born OR hatched OR newborn', { hint: ['animals'], need: 'animals' }),
  ...googleSearch('viral animal OR "goes viral" dog OR cat OR raccoon OR capybara', { hint: ['animals', 'funny'], need: 'animals' }),
  ...googleSearch('escaped animal OR "animal on the loose" OR "loose animal"', { hint: ['animals', 'funny'], need: 'animals' }),
  ...googleSearch('funny animal video OR "caught on camera" animal', { hint: ['animals', 'funny'], need: 'animals' }),
  { name: 'The Guardian', url: 'https://www.theguardian.com/environment/wildlife/rss', hint: ['animals'] },
  { name: 'Mongabay', url: 'https://news.mongabay.com/feed/', hint: ['animals'] },
  { name: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/', hint: ['goodnews'] },
  { name: 'Reddit r/aww', url: 'https://www.reddit.com/r/aww/hot.rss?limit=40', hint: ['animals', 'funny'], optional: true },

  // ---- funny and odd ----
  { name: 'UPI Odd News', url: 'https://rss.upi.com/news/odd_news.rss', hint: ['funny'] },
  { name: 'Oddity Central', url: 'https://www.odditycentral.com/feed', hint: ['funny'] },
  { name: 'Reddit r/nottheonion', url: 'https://www.reddit.com/r/nottheonion/hot.rss?limit=30', hint: ['funny'], optional: true },

  // ---- space ----
  ...googleSearch('NASA OR SpaceX OR asteroid OR comet OR "meteor shower" OR eclipse OR "space station"', { hint: ['space'], need: 'space' }),
  { name: 'NASA', url: 'https://www.nasa.gov/feed/', hint: ['space'] },
  { name: 'Space.com', url: 'https://www.space.com/feeds/all', hint: ['space'] },
  { name: 'SpaceNews', url: 'https://spacenews.com/feed/', hint: ['space'] },
  { name: 'Spaceflight Now', url: 'https://spaceflightnow.com/feed/', hint: ['space'] },
  { name: 'Universe Today', url: 'https://www.universetoday.com/feed', hint: ['space'] },
  { name: 'ESA', url: 'https://www.esa.int/rssfeed/Our_Activities/Space_News', hint: ['space'] },
  { name: 'The Guardian', url: 'https://www.theguardian.com/science/space/rss', hint: ['space'] },
  { name: 'Reddit r/space', url: 'https://www.reddit.com/r/space/hot.rss?limit=30', hint: ['space'], optional: true },

  // ---- general science and nature (shows up under "Everything") ----
  { name: 'BBC Science & Environment', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
];
