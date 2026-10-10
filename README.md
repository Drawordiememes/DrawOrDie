# Hourly Wire

A website that rebuilds itself every hour from news feeds and shows:

- **Animals**: anything animal-related, with a strip of which animals are in the news right now
- **Rescues & saving**: rescues, shelters, strandings, petitions and campaigns to save animals
- **Funny**: odd and funny stories
- **Space**: NASA, launches, comets, eclipses and more
- **Good news**: heartwarming stories
- **Everything**: all of it together

You can look at the past hour, 3, 6, 24 or 48 hours. Stories that are new since the last update get a **NEW** badge. The same story from several outlets is grouped into one card ("+3 more outlets"). Named animals ("Jimothy", "Pudding") are pulled out of headlines and shown as chips you can click to copy. Upsetting stories (deaths, cruelty, attacks) are hidden by default, with a checkbox to show them.

There are two ways to run it. **Pick one, not both.**

| | A. GitHub Pages (recommended) | B. Railway (or any host that runs Node) |
|---|---|---|
| Cost | Free | Uses the host's credits or plan, since it runs 24/7 |
| How it updates | GitHub runs a scheduled job each hour | The server refreshes itself each hour |
| Needs | A public GitHub repo | A host that runs `npm start` |

## A. GitHub Pages (about 10 minutes)

GitHub runs the update on a schedule and publishes the page with GitHub Pages. There is nothing to host or pay for.

1. **Make a new repository** on GitHub. Make it **public** (GitHub Pages is free for public repositories).
2. **Upload everything in this folder** to it. On the repo page choose *Add file → Upload files* and drag the contents in.
   - The hidden `.github` folder has to come along. If you don't see `.github/workflows/update.yml` in the repo afterwards, choose *Add file → Create new file*, type `.github/workflows/update.yml` as the name, and paste in the contents of `workflow-copy/update.yml`.
3. **Turn on Pages**: *Settings → Pages → Build and deployment → Source: GitHub Actions*.
4. **Run it once**: open the *Actions* tab, click *Update site* on the left, then *Run workflow*. (If GitHub asks you to enable workflows, say yes.) After a minute or two your site is live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

From then on it updates by itself at about 7 minutes past every hour.

## B. Railway (or another host that runs Node)

The project includes a small server, so a host that runs `npm start` can run it directly. It shows the page and refreshes the stories at 7 minutes past every hour by itself, and also once when it starts.

1. Put the files in a GitHub repo and create a Railway service from that repo. No build settings are needed: Railway runs `npm start`.
2. In the service, open *Settings → Networking* and generate a public domain.
3. Alerts (optional): add the variables `NTFY_TOPIC` or `DISCORD_WEBHOOK_URL` in the service's *Variables* tab, plus `SITE_URL` set to your Railway domain so tapping an alert opens it. `NOTIFY_TAGS` and `NOTIFY_EMPTY` work the same way as below.
4. **Delete the `.github` folder from the repo** (or turn the workflow off in the Actions tab). Otherwise GitHub keeps trying to publish to GitHub Pages and emails you about the failed runs.

Visit `/healthz` on your domain to check the server is up. The first page load after a deploy shows sample data for about a minute, until the first refresh finishes. If a deploy fails, open *View logs* and read the last few lines.

## Get told every hour (optional)

On Pages these are repo *secrets and variables* (below). On Railway they are the service's *Variables*.

The website shows the latest, but it can't tap you on the shoulder. For that, add one of these as a secret (*Settings → Secrets and variables → Actions → New repository secret*):

**Phone notifications with ntfy (free)**
1. Install the **ntfy** app (iPhone or Android).
2. In the app, subscribe to a topic with a long random name, for example `critters-8f3k2x9qv7m1`. Anyone who knows the name can read it, so don't use something guessable.
3. Add a repository secret named `NTFY_TOPIC` with that same name.

**Discord**: create a webhook in a channel (*Channel settings → Integrations → Webhooks*) and save its URL as a secret named `DISCORD_WEBHOOK_URL`.

Each hour you get a short message such as "7 new animal stories", the animals that are buzzing, and the top stories. If nothing new turned up, it stays quiet. To change that, add repository **variables** (*Settings → Secrets and variables → Actions → Variables*):

| Variable | What it does |
|---|---|
| `NOTIFY_TAGS` | Which sections can trigger an alert. Default `animals`. Try `animals,space` or `animals,rescue,funny`. |
| `NOTIFY_EMPTY` | Set to `1` to also get a message when nothing is new. |
| `SITE_URL` | Only needed if you use a custom domain. |

## Change what it watches

- **Sources**: edit `scripts/feeds.mjs`. Any RSS or Atom link works. Google News searches are easy to add or change there.
- **What counts as an animal, a rescue, funny, space**: the word lists are near the top of `scripts/lib.mjs`.
- **Look**: `site/index.html` is one plain file.

## Things worth knowing

- **"Hourly" means about hourly.** GitHub's scheduler can run late, sometimes by 10 to 30 minutes when it is busy.
- **Some sources will fail sometimes.** Reddit often blocks cloud servers, and websites change their feed addresses. The page lists every source and whether it worked (*"x of y sources responded"* at the bottom), and the job keeps going with the rest. If every source fails, the old page stays up instead of going blank.
- **Times come from each feed.** A story's "past hour" status is only as good as the time the publisher gave.
- **GitHub pauses scheduled jobs in public repos after 60 days with no commits.** The workflow adds an empty commit once a month to prevent that. If the page ever shows "last update was N hours ago", check the Actions tab.
- **It does not read X/Twitter.** X has no free feed. News sites and Reddit cover most viral animal stories within the hour.
- **The page starts with sample data** (a banner says so) until the first real update runs.

## Try it on your own computer

You need Node 18 or newer. There is nothing to install.

```
node scripts/update.mjs --demo   # build sample data
node scripts/serve.mjs           # open http://localhost:8080 (page only)
node scripts/update.mjs          # fetch the real feeds
node scripts/server.mjs          # page plus hourly refresh (what `npm start` runs)
node scripts/selftest.mjs        # run the checks
```

## A note on using this for meme coins

The page shows what people are talking about, not what will go up. Real animals in distress, and the people trying to help them, are not a marketing angle, and rescue appeals are often asking for donations, so don't launch a token that looks like one. Using a real person's name or photo, or a brand, can cause legal trouble, and token sales can fall under securities rules depending on where you live. Not financial or legal advice.
