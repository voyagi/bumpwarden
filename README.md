# bumpwarden

A background agent that owns dependency-update triage for a repository. On a schedule it reads what
a project depends on, scores every pending bump's break risk against a published rubric, has Gemini
explain what would break in that project's own code, and then acts on GitHub: a pull request for a
safe bump, an issue for a risky one, a hold for a dangerous one. It never merges anything.

Dependabot and Renovate bump. bumpwarden judges, explains, and acts, with a score you can read.

The verdict is deterministic. Gemini writes the explanation and maps release notes onto your call
sites, and every claim it makes is checked against the material it was given before it is shown. A
claim that cannot be traced back is dropped rather than published.

## Architecture

![Cloud Scheduler calls the run endpoint on Cloud Run with an OIDC token. The endpoint reads GitHub, the npm registry and deps.dev, scores each bump deterministically, and sends the release notes to an agent on gemini-3.5-flash whose branch ends at the explanation. Policy turns the score into a GitHub action, and everything is written to Firestore, which the dashboard reads.](docs/architecture.svg)

| Piece                                | What it is                                                                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini 3.5 Flash                     | Writes the upgrade brief and maps changed symbols onto your code. Structured output, validated with zod.                                                                                |
| Agent Development Kit for TypeScript | `@google/adk`. An `LlmAgent` with four read-only tools over material already fetched. It holds no GitHub write tool, and an architecture rule fails the build if anything gives it one. |
| Cloud Run                            | One service in `europe-west1`: the dashboard and the run endpoint.                                                                                                                      |
| Cloud Scheduler                      | The cron trigger that makes this a background agent rather than a button.                                                                                                               |
| Firestore                            | Runs, bumps, briefs, actions, and the watch list.                                                                                                                                       |
| GitHub REST, npm registry, deps.dev  | The evidence. No scraping, no paid APIs.                                                                                                                                                |

## What one run does

1. Read each watched repository's `package.json` and lockfile from GitHub, plus a bounded slice of
   its source files.
2. Resolve the candidate version for every dependency from the npm registry and deps.dev, and
   collect release notes, the diff between tags, and any advisories.
3. Score each candidate bump from 0 to 100 with a pure function over nine named factors. Every
   factor carries its points, its evidence and a link to the source it came from.
4. Ask the agent for a brief: what changed, what breaks here with file and line evidence, how to
   migrate, and how sure it is. A brief that fails validation is retried once and then recorded as
   unavailable. It is never faked.
5. Apply the policy for the band, act on GitHub, and write the run, the bumps, the briefs and the
   actions to Firestore.

A second run over the same bump updates the issue or pull request the first run opened. It does not
open another.

## The score and the policy

Bands: **green 0 to 30**, **amber 31 to 60**, **red 61 to 100**. The full rubric, with every weight
and its source, is published on the running service at `/rubric`, and it is generated from the same
constants the scorer adds up, so the page cannot drift from the verdict.

| Band  | Rule          | Action                                                                                                                                                    |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| green | `GRN-PR-1`    | Open a pull request with the bump and the brief. If Dependabot or Renovate already opened one for the same bump, comment there instead of duplicating it. |
| amber | `AMB-ISSUE-1` | Open an issue with the brief and a migration checklist, labelled `bumpwarden:review`. No pull request.                                                    |
| red   | `RED-HOLD-1`  | Open a hold issue with a migration plan, labelled `bumpwarden:hold`. Never a pull request.                                                                |

There is no merge action, and no setting adds one. The union of actions the code can take has no
merge member, and a test fails if one appears.

Three limits apply per run: at most 20 briefs, at most 10 actions, and a 10 minute deadline after
which a run stops asking for briefs, so a slow answer upstream cannot push it past its request
timeout. Bumps are handled riskiest first, and anything a limit cuts is still scored and still acted
on, with the reason stored on the record. A green bump's pull request edits `package.json` and
nothing else, because bumpwarden does not run your package manager against your lockfile.

## Run it locally

You need Node 24.13 or newer. `.node-version` pins the version this repository is built against.

```sh
git clone https://github.com/voyagi/bumpwarden.git
cd bumpwarden
npm install
cp .env.example .env
npm run dev
```

That is enough to open <http://127.0.0.1:8080>. With no credentials the service uses an in-memory
store and skips the brief, so every page renders and nothing reaches Google Cloud.

Fill in `.env` to go further:

| Variable                  | Meaning                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`          | A key from Google AI Studio. The free tier is enough. Without it, briefs are recorded as unavailable.                                     |
| `GITHUB_TOKEN`            | A fine-grained token with contents, issues and pull requests on the repositories you watch. Without it, actions are recorded as dry runs. |
| `GOOGLE_CLOUD_PROJECT`    | Switches the store from memory to Firestore.                                                                                              |
| `FIRESTORE_EMULATOR_HOST` | Points the Firestore client at a local emulator.                                                                                          |
| `RUN_INVOKER_EMAIL`       | The service account Cloud Scheduler signs its token with. The run endpoint accepts no other caller.                                       |
| `SERVICE_BASE_URL`        | The public URL of the service. It is also the OIDC audience the run endpoint requires.                                                    |
| `DEMO_REPO`               | The one repository dashboard visitors may trigger with "Run now".                                                                         |
| `HOST`, `PORT`            | Where to listen. `HOST=all` means every interface, which is what the container image sets.                                                |

Against a local Firestore, in two terminals. The emulator ships with the Firebase CLI and needs a
Java runtime; `GOOGLE_CLOUD_PROJECT` is what switches the store away from memory, so both variables
have to be set or the emulator sits there unused:

```sh
npm install -g firebase-tools                      # once, if you do not have it
npm run emulator                                   # terminal one, serves on 8081

$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8081'    # terminal two, PowerShell
$env:GOOGLE_CLOUD_PROJECT = 'demo-bumpwarden'
npm run dev
```

Other commands:

```sh
npm run verify:ship   # types, tests, lint, format, the gate chain, and the build, in that order
npm test              # the suite on its own
npm run test:coverage # the suite with a coverage report
npm run mutate        # mutation testing over the deterministic core
npm run dryrun -- owner/repo   # the whole pipeline over a real repository, writing nothing
npm run smoke:brief   # one real Gemini call over material checked into the script
npm run demo:check    # score the demo repository against live registry data
npm run docs:diagram  # regenerate docs/architecture.svg from the About page's own component
```

`npm run dryrun` is the honest way to try bumpwarden on a project before granting a token that can
push: it fetches, scores and explains every pending bump and records what it would have opened,
without touching the repository. It reads `GITHUB_TOKEN` for the API rate limit, `GEMINI_API_KEY`
for the briefs, and `GOOGLE_CLOUD_PROJECT` when the result should land in Firestore rather than in
memory.

## Deploy it to Cloud Run

Every command below is a real step. The values are the ones this project uses, so change the
project id and the repository names to yours. Nothing here needs a paid tier.

**1. Pick the project and turn on the services.**

```sh
gcloud config set project bumpwarden
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com firestore.googleapis.com
```

**2. Create the Firestore database**, once, in the same region as the service. Native mode, database
id `(default)`, location `europe-west1`.

```sh
gcloud firestore databases create --location=europe-west1 --type=firestore-native
```

**3. Put the two secrets in Secret Manager**, replicated inside the EU rather than worldwide. The
two ids are used again below, so they are set once here.

```sh
GEMINI_ID=bumpwarden-gemini-api-key
GITHUB_ID=bumpwarden-github-token

printf '%s' "$GEMINI_API_KEY" | gcloud secrets create "${GEMINI_ID}" \
  --replication-policy=user-managed --locations=europe-west1 --data-file=-
printf '%s' "$GITHUB_TOKEN" | gcloud secrets create "${GITHUB_ID}" \
  --replication-policy=user-managed --locations=europe-west1 --data-file=-
```

**4. Create the two service accounts.** One identity runs the service, the other one calls it.
Splitting them is what makes the run endpoint's check mean something.

```sh
gcloud iam service-accounts create bumpwarden-service --display-name="bumpwarden runtime"
gcloud iam service-accounts create bumpwarden-scheduler --display-name="bumpwarden scheduler"
```

**5. Grant the runtime identity exactly what it needs**, which is Firestore and the two secrets.

```sh
gcloud projects add-iam-policy-binding bumpwarden \
  --member=serviceAccount:bumpwarden-service@bumpwarden.iam.gserviceaccount.com \
  --role=roles/datastore.user

for id in "${GEMINI_ID}" "${GITHUB_ID}"; do
  gcloud secrets add-iam-policy-binding "$id" \
    --member=serviceAccount:bumpwarden-service@bumpwarden.iam.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor
done
```

**6. Deploy.** Cloud Build reads the `Dockerfile` in this repository.

```sh
gcloud run deploy bumpwarden \
  --source . \
  --region europe-west1 \
  --service-account bumpwarden-service@bumpwarden.iam.gserviceaccount.com \
  --set-env-vars GOOGLE_CLOUD_PROJECT=bumpwarden,DEMO_REPO=voyagi/bumpwarden-demo-app,RUN_INVOKER_EMAIL=bumpwarden-scheduler@bumpwarden.iam.gserviceaccount.com \
  --set-secrets GEMINI_API_KEY=${GEMINI_ID}:latest,GITHUB_TOKEN=${GITHUB_ID}:latest \
  --allow-unauthenticated \
  --cpu 1 --memory 512Mi --timeout 900 --min-instances 0 --max-instances 2
```

`--allow-unauthenticated` publishes the dashboard, which is meant to be read by anyone. It does not
open the run endpoint: `POST /run` verifies the caller's OIDC token inside the application and
answers 403 to everything else. See [docs/deploy-review.md](docs/deploy-review.md).

**7. Tell the service its own URL.** The OIDC audience is the exact URL the scheduler calls, so the
service cannot know it until it exists. Until this step the run endpoint answers 503 by design.

```sh
SERVICE_URL=$(gcloud run services describe bumpwarden --region europe-west1 --format='value(status.url)')
gcloud run services update bumpwarden --region europe-west1 \
  --update-env-vars "SERVICE_BASE_URL=$SERVICE_URL"
```

**8. Create the scheduler job.** Twice a day, at 06:00 and 18:00 UTC, which is what the dashboard
tells readers to expect.

```sh
gcloud scheduler jobs create http bumpwarden-run \
  --location europe-west1 \
  --schedule "0 6,18 * * *" \
  --time-zone "Etc/UTC" \
  --uri "$SERVICE_URL/run" \
  --http-method POST \
  --oidc-service-account-email bumpwarden-scheduler@bumpwarden.iam.gserviceaccount.com \
  --oidc-token-audience "$SERVICE_URL/run" \
  --attempt-deadline 1800s
```

**9. Check it.** The first two answers prove the endpoint is shut to strangers, the third runs it
for real.

```sh
curl -s "$SERVICE_URL/healthz"                       # {"ok":true,"service":"bumpwarden"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SERVICE_URL/run"   # 401
gcloud scheduler jobs run bumpwarden-run --location europe-west1
```

Watch it work with `gcloud beta run services logs tail bumpwarden --region europe-west1`. Every run
writes `run started`, one `bump handled` line per bump with its score, band, rule and URL, and
`run finished` with the counts. The lines are JSON, and a credential never reaches them.

## Watch a repository

The watch list is a Firestore document, and this service has no accounts, so there is no admin page
to log into. Add one from the command line:

```sh
npm run watch -- voyagi/bumpwarden-demo-app --demo
npm run watch -- your-org/your-service
```

`--demo` marks the one repository dashboard visitors may trigger with "Run now", rate-limited to one
run per five minutes. Everything else runs only on the schedule. The service also seeds `DEMO_REPO`
at boot, so a fresh deployment already watches it.

The token you deployed with decides what bumpwarden can do to a repository. With read access it
records dry runs and changes nothing, which is a reasonable way to try it on someone else's project.

## The demo repository

[voyagi/bumpwarden-demo-app](https://github.com/voyagi/bumpwarden-demo-app) is a small release-notes
board pinned to seven real, stale packages. Its contents live in [demo/](demo/). The pins were
chosen so one run reaches every band: `glob` and `chalk` score red, `node-fetch`, `express` and
`body-parser` score amber, `morgan` and `cookie-parser` score green.

`npm run demo:check` proves that against live registry data without deploying anything. It reads the
npm registry, deps.dev and the upstream release notes over the network, feeds the demo app's own
files in from disk, and fails if any band is missing.

## Quality gates

`npm run verify:ship` is the single ship gate: typecheck, the full test suite, whole-repo lint, then
the committed floors (complexity, duplicated logic, architecture boundaries). It prints one exit code
per step. The same chain runs in GitHub Actions on every pull request and on every push to `main`.

The architecture rules are enforced, not documented: `src/core` may not import any other layer, and
`src/agent` may not import the GitHub client. Both fail the build when crossed.

## Limits

npm only in v1, though the resolver is shaped so another ecosystem can follow. No private registries.
No accounts and no multi-tenancy: this is a single-operator instance. The usage matcher is
mechanical and identifier-based, so it sees a renamed method and misses a changed route syntax, and
the dashboard says which of the two a given verdict rests on. Free-tier limits on the Gemini key
decide how many bumps one run can explain, which is why the brief budget exists.

## License

MIT, see [LICENSE](LICENSE).
