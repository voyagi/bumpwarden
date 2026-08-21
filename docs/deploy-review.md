# Deploy review

What the deployed service exposes, what identity it runs as, and what it can reach. Written against
the deploy steps in [../README.md](../README.md); if those change, this changes with them.

## Surface

|              |                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime      | Cloud Run service `bumpwarden`, region `europe-west1`, one container.                                                                                                        |
| Port         | One, injected by Cloud Run as `PORT` and defaulting to 8080. Nothing else listens.                                                                                           |
| Bind address | Every interface, which Cloud Run requires of the ingress container. `HOST=all` in the image, which makes the server omit the hostname so Node binds the unspecified address. |
| Ingress      | Cloud Run's default: the internet, over TLS that Cloud Run terminates. There is no VPC connector, no static IP and no inbound path to anything else.                         |
| Local runs   | Loopback only. `HOST` defaults to `127.0.0.1`, so a development server is not reachable from the network.                                                                    |

## Who can call what

`--allow-unauthenticated` is deliberate and is not the same as an open service.

- **Every page except one is public and read-only.** The dashboard exists to be read by anyone,
  including a judge with a link. It renders from Firestore and takes no input beyond a path.
- **`POST /run` verifies an OIDC token in the application.** The token must be signed by Google, be
  addressed to this exact service URL as its audience, carry a verified email, and match
  `RUN_INVOKER_EMAIL`. Anything else gets 401 or 403.
- **The endpoint fails closed.** With no configured invoker or no configured audience it answers 503
  rather than accepting the call. Verification is refused outright when there is no audience to
  check against, because an unchecked audience would accept a token minted for another service.
- **"Run now" is not that endpoint.** It is a form on the dashboard, allowed only for the repository
  marked as the demo, one run per project per five minutes, answering 409 while a run is going. The
  cooldown is keyed on the project rather than on the visitor: this instance has no accounts, and an
  IP address is personal data it has no reason to hold.

## Identities and secrets

| Identity               | What it can do                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bumpwarden-service`   | Runs the container. `roles/datastore.user` on Firestore, and read on the two secret versions. Nothing else. |
| `bumpwarden-scheduler` | Only mints the OIDC token Cloud Scheduler sends. It holds no project role at all.                           |

`GEMINI_API_KEY` and `GITHUB_TOKEN` live in Secret Manager with a user-managed replication policy
pinned to `europe-west1`, and reach the container as environment variables at start. Neither is ever
written to a log: the logger redacts by field name and by credential shape, and a test proves it.

The GitHub token is fine-grained and scoped to the watched repositories. It is the ceiling on what
bumpwarden can do to a repository: with read access only, every action is recorded as a dry run.

## What it writes

- **GitHub**: issues, pull requests, and comments on bot pull requests, in the watched repositories
  only. Every route re-applies the owner and repository from the actor's constructor, so no call can
  leave the repository it was built for. There is no merge, and the union of actions the code can
  take has no merge member.
- **Firestore**: runs, bumps, briefs, actions and the watch list, in the same region.
- **Logs**: one JSON object per line to stdout, with the run id, scores, bands, rules and outcomes.

## Data

No accounts, no visitor tracking, no cookies, no analytics. The stored data is public repository
metadata, public release notes, and the service's own decisions. Fonts and stylesheets are served
from the container, so opening a page reaches no third party. Free-tier Gemini traffic may be used
by Google to improve its products, and what is sent is public release notes and public source lines.

## Residual risks

- **A compromised GitHub token could write to the watched repositories**, within its fine-grained
  scope. Mitigated by scope, by rotation being one Secret Manager version away, and by the fact that
  nothing bumpwarden opens can merge itself.
- **Release notes are untrusted input read by a model.** They are passed as data, the agent has no
  write tool, and every claim it returns is checked against the material it was given before it is
  shown. Prompt text in a changelog can waste a call. It cannot reach GitHub.
- **A public run trigger costs money in principle.** In practice it is one repository, rate-limited,
  bounded by a call budget per run and by the brief and action budgets, and the whole thing sits
  inside free tiers.
