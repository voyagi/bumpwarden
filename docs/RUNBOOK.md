# Runbook

What to do when the hosted bumpwarden misbehaves. Written for you, the operator who deployed it
with the nine commands in the README, so every command below assumes those names: the service
`bumpwarden` in `europe-west1`, the two service accounts, the two secrets. Read the log first: every
run writes `run started`, one `bump handled` per bump, and `run finished`, as JSON, with
credentials redacted. `gcloud beta run services logs tail bumpwarden --region europe-west1` follows
it live.

## 1. Code rollback (Cloud Run)

Every deploy creates a revision and the old ones stay. Rolling back is moving all traffic to a
revision that worked:

```sh
gcloud run revisions list --service bumpwarden --region europe-west1
gcloud run services update-traffic bumpwarden --region europe-west1 --to-revisions REVISION=100
```

Put the name from the first command where `REVISION` is. This takes seconds and touches no data.
A run that was in progress on the old revision is cut off, and the next scheduled run starts
clean, because a run's lease expires after 20 minutes on its own.

Roll back when a deploy breaks a page, or when a run starts failing right after one. Two things it
will not fix. A quota refusal is section 4. A `model missing` at boot is section 3, unless the
deploy you are undoing is the one that changed `BRIEF_MODEL`: if Google retired the id, every
older revision names that same id and fails the same way, so the way out is forward.

## 2. Data rollback (Firestore), stated separately

There is no automatic rollback for the data, and the free tier does not give you one: Firestore's
point-in-time recovery is off by default, keeps at most seven days, and needs billing. This
deployment runs without it on purpose.

What that means, honestly:

- Runs, bumps and briefs are rebuilt from their sources. The next run re-reads GitHub, the npm
  registry and deps.dev, re-scores every bump, and re-uses a ready brief from the store or asks
  the model again. A lost bump costs one run, a lost brief costs two model requests.
- The audit log (the `actions` collection) is the one thing a run does not recreate, and it is the
  one loss that is partly permanent. Actions that reached GitHub can be read back off the issues,
  pull requests and comments that still carry their marker and body, so far as nobody has edited
  or deleted those. Actions recorded as dry runs never reached GitHub at all, by definition, so
  nothing outside Firestore holds them. Export the collection if you need the log to be complete.
- The watched-repositories list is seeded at boot from `DEMO_REPO`. Any repository you added with
  `npm run watch` has to be added again.
- A `409` on "Run now", or `run started` with no `run finished`, means a lease is held. That is the
  ordinary shape of a run that is still going, so read it as busy first and as stuck only once you
  have confirmed the execution ended, or that the lease has outlived the run that took it.
  The lease is a document under `locks/`, and which one depends on what it covers: `locks/run` for
  a run over the whole watch list, `locks/run:scoped` for a project-scoped press, and
  `locks/run:owner__repo` for the repository itself (the id is the key with each `/` written as
  `__`). A `repository held` line in the logs means a watch-list run found a repository already
  leased and left it alone rather than reading it twice; that repository is not dated by that run.
  Once a run really is stuck: **wait for the lease to expire.** Twenty
  minutes is the whole remedy, and it is the safe one. Deleting the lease by hand only looks
  faster: moving traffic to another revision does not end a request already running on the old
  one, so a run you assumed was dead can still be writing to Firestore and posting to GitHub, and a
  second run started against a freed lease would be doing the same work beside it. Delete the
  document only once you know the execution that took it is gone. Never delete the `runs`
  collection to free a run.

If you ever need more than this, turn on point-in-time recovery in the console before the
incident, not after, and accept that it is billed.

## 3. The live-health verdict, what each one means

A monitor outside the service checks the routes and markers listed in its manifest. Read its
verdict like this:

- **A route answers but the marker is missing.** A stale or wrong revision is serving. Compare the
  revision in the Cloud Run console with the one you meant to deploy, then section 1.
- **`/health` answers and an HTML route does not.** The app boots but a page throws. The log has
  the stack. Roll back (section 1), then fix forward.
- **Nothing answers.** Cloud Run is down or the service was deleted. `gcloud run services
describe bumpwarden --region europe-west1` says which. A deleted service is re-created by the
  README's step 6 onward, and the data in Firestore survives it.
- **A stylesheet or font fails.** The page still renders. A deploy that dropped `public/` is the
  usual cause: rebuild from a clean clone.
- **`model missing` in the boot log.** The model id no longer resolves. Move `BRIEF_MODEL` in
  `src/core/stack.ts` to the current id, re-pin it in `docs/adr/0001-stack.md`, deploy. Until
  then every brief records "unavailable" and the scores still stand.
- **`model refused the key` in the boot log.** The API rejected the request on the credential, not
  on the model. Nothing retries its way out of this and every brief in every run will record
  "unavailable", so treat it as an outage of the explanation half. **Read the reason on the line
  before deciding what to do**, because the same refusal covers more than one cause and only some
  of them are the key's fault. `API_KEY_INVALID` is a key deleted in AI Studio, a key from the
  wrong Google project, or a secret version added without the service being updated to read it:
  rotate with section 5, then restart. A reason naming the service, the project or billing
  (`SERVICE_DISABLED`, `PERMISSION_DENIED`, `CONSUMER_INVALID`) is not fixed by rotating anything;
  the key is fine and the project's access to the API is not. A bare `HTTP 403` with no reason
  named means the API refused without saying why: check the project in the console before touching
  the key.
- **`model not checked` in the boot log.** The probe could not reach the API at all, which says
  nothing about the model. It is a warning rather than an error for that reason. If it repeats on
  every cold start, read the reason it names: a code such as `ENOTFOUND` or `ECONNREFUSED` points
  at egress from the service, not at Google.

## 4. External dependencies, and how each one fails

| Dependency                      | Used for                                                            | When it fails, the run ...                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub REST API                 | manifests, lockfiles, releases, tag compares, issues, pull requests | records the missing source on the bump, scores what it has, and keeps going. A write refused for scope is recorded as a dry run                                                                                                                                                                                                                        |
| npm registry                    | versions, publish times                                             | reads the two version documents first and the whole list last, and records a gap over the 24 MB cap                                                                                                                                                                                                                                                    |
| deps.dev                        | publish times, advisories, deprecation                              | falls back to the registry for time, and records the missing advisory read                                                                                                                                                                                                                                                                             |
| Gemini API (`gemini-3.5-flash`) | the brief                                                           | paces itself under 5 requests a minute and about 20 a day, waits the time a refusal names, and records "brief unavailable" with the reason after one retry. The verdict never depends on it                                                                                                                                                            |
| Cloud Scheduler                 | the twice-daily trigger                                             | nothing runs until the job is back. "Run now" on the demo project still works                                                                                                                                                                                                                                                                          |
| Firestore                       | all state                                                           | the run fails at its write and says so. The run record is written before the work, so a run that began is always on record; a failure partway leaves the bumps already written, which the next run re-reads and re-scores. Ordering is not atomicity: a GitHub write followed by a failed state write can leave the two disagreeing until the next run |
| Secret Manager                  | the two credentials at boot                                         | the service does not start. Check the two IAM grants in the README's step 5                                                                                                                                                                                                                                                                            |

The free tier's daily model allowance is the dependency most likely to fail on a demo day: a
fresh run over the seven demo bumps spends 14 of the 20 requests, a repeat run over unchanged
bumps spends none. Check the AI Studio quota page before a recording, and do not rehearse.

## 5. Key rotation

Two credentials exist, both in Secret Manager, both read at boot only.

- **Gemini API key.** Create the new key in AI Studio, add it as a new secret version, then restart
  the service so it reads it:

  ```sh
  GEMINI_ID=bumpwarden-gemini-api-key
  printf '%s' "$NEW_GEMINI_API_KEY" | gcloud secrets versions add "${GEMINI_ID}" --data-file=-
  gcloud run services update bumpwarden --region europe-west1 \
    --update-secrets "GEMINI_API_KEY=${GEMINI_ID}:latest"
  ```

  Disable the old key in AI Studio after the next successful brief, not before.

- **GitHub token.** It is a fine-grained token limited to the watched repositories, and it
  expires on the date you set when you made it: write that date down. Rotate the same way with
  `bumpwarden-github-token` and `GITHUB_TOKEN`. Without push access the service keeps running and
  records what it would have done.

- **The scheduler's identity** is a service account with no key to rotate. Its OIDC token is
  minted per call and verified in the app against the service's own URL.

After any rotation, run the README's step 9: `/health`, the `401` on a bare `POST /run`, then one
scheduled run, and read `run finished` in the log.
