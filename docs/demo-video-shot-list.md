# Demo video shot list

Four minutes, recorded in one take, nothing sped up or cut. A run over the demo repository whose
briefs are already cached takes about ten seconds; one that has to write all seven briefs takes
about three minutes, because the free tier answers five model requests a minute and twenty a day,
and a brief costs two. The plan below triggers the run early either way and spends any wait on the
rubric and the policy rather than on a progress bar. Everything on screen is the deployed service.

## Before recording

- [ ] The deployed service answers: `/healthz` returns `{"ok":true,...}` and the dashboard loads.
- [ ] **Run it once before recording, the same day, after 09:00 CEST when the free day resets.**
      That run spends 14 of the day's 20 model requests and leaves seven ready briefs in the
      cache. Check the queue page shows every brief as ready. The recorded run then reads GitHub,
      npm and deps.dev live again and takes its briefs from the cache, which is the same artifact
      a judge gets on a repeat press. Do not rehearse a second fresh run: there is not enough day
      left for it.
- [ ] The demo repository has no open bumpwarden issues or pull requests. Close the ones the
      warm-up run opened, so the recorded run opens fresh ones rather than updating them. Updating
      is the honest behaviour on a second run, and it is worth showing once, but not as the only
      thing that happens.
- [ ] The five minute "Run now" cooldown has expired.
- [ ] Three browser tabs, in this order: the dashboard, the Cloud Run logs page in the Google Cloud
      console, the demo repository's issues page on GitHub.
- [ ] Screen at 1440 wide or more, browser zoom at 100 percent, notifications off.
- [ ] `npm run demo:check` passed today, so the three bands are known to be reachable.

## The shots

### 1. The problem (0:00 to 0:25)

On screen: the demo repository's `package.json`, seven pinned dependencies.

Say: a service nobody has touched for a while. Seven dependencies are behind. Dependabot would open
seven pull requests and tell you nothing about which of them will break your build. That triage is
the work, and it is the work bumpwarden takes over.

### 2. Start the run (0:25 to 0:50)

On screen: the bumpwarden dashboard, the demo project, then press **Run now**.

Say: this is the same run Cloud Scheduler fires twice a day. It reads the manifest and the lockfile
from GitHub, resolves candidates from the npm registry and deps.dev, scores every bump, and acts.

Switch to the Cloud Run logs tab as soon as the button turns to "running". **This is the Google
Cloud shot.** Point at `run started`, the service name, the region.

### 3. What the score is, while the run works (0:50 to 1:45)

On screen: the Policy page at `/rubric`.

Say: the verdict is not the model's opinion. Nine factors, fixed weights, published and versioned.
Semver distance, release age, advisories, deprecation, breaking markers, engine range, peer ranges,
and whether your code touches a symbol the release notes say changed. Green opens a pull request,
amber opens an issue, red opens a hold. There is no merge action anywhere in the policy, by design.

Glance back at the logs tab once, mid-sentence, to show `bump handled` lines arriving with scores.

### 4. The queue (1:45 to 2:20)

On screen: back to the dashboard, the run has finished, the queue has filled.

Say: seven bumps, sorted riskiest first. Three red, two amber, two green, and the same numbers on
the run record. Point at `glob 7 to 13` at the top and `cookie-parser` at the bottom. Read the
split off the screen rather than from this page: a dependency that publishes a new version before
the recording can move a row across a band.

### 5. One bump, in full (2:20 to 3:10)

On screen: open the `glob` bump detail.

Say: 45 points because it crosses six majors. 20 because this repository calls something the release
evidence says changed, and here are the file and line. Then the brief: what changed, what breaks
here, how to migrate, and the confidence. Every claim is checked against the material the model was
given, and one that cannot be traced is dropped rather than shown.

### 6. What it did about it (3:10 to 3:40)

On screen: the GitHub tab, refreshed.

Say: a hold issue for the red one, labelled `bumpwarden:hold`, carrying the brief. An issue for each
amber. A pull request for the green ones, editing `package.json` only. Open the hold issue and
scroll the brief once.

### 7. The audit log (3:40 to 3:55)

On screen: the dashboard's audit log.

Say: every action, with the policy rule that fired and a timestamp. Run it again tomorrow and it
updates these instead of opening more. That is the whole loop, and nothing in it merged anything.

## If something goes wrong on the take

- A run that finds nothing new: the demo repository already has open bumpwarden issues. Close them
  and start again.
- 429 on "Run now": the cooldown. Wait it out rather than restarting the service.
- A brief that comes back unavailable: the free-tier Gemini limit, most likely the day's twenty
  requests already spent. Say so on camera and move on. The score and the action are deterministic
  and do not depend on the brief, and the next run after the reset fills it in.
