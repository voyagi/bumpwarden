# ADR 0001: Stack

Status: accepted, 2026-08-20

## Context

bumpwarden is a scheduled background agent with a small public dashboard. It must use Gemini 3.5
or newer, a Google agent framework and at least one Google Cloud service, run on free tiers, ship
inside one container, and be built in about ten days by one person. The dashboard is six mostly
read-only pages and one button. The core of the product is a deterministic scoring pipeline that
must stay testable without any network.

## Decision

TypeScript end to end on Node 24 (the agent framework requires 24.13 or newer).

- Agent: `@google/adk` (`LlmAgent`, `FunctionTool`, `Runner`) with `@google/genai` underneath,
  model `gemini-3.5-flash`. The agent is one bounded step that returns a brief. It has no tool
  that can write to GitHub or Firestore.
- Server: Hono with `@hono/node-server`, server-rendered pages through `hono/jsx`, one Cloud Run
  service that hosts both the dashboard and the run endpoint. Cloud Scheduler triggers the run
  endpoint with an OIDC token, verified in the app with `google-auth-library`, because a Cloud Run
  invoker policy applies to the whole service and the dashboard must stay public.
- State: Firestore through `@google-cloud/firestore`. Deterministic document ids for bumps and
  briefs so re-runs update instead of duplicating.
- GitHub: `@octokit/rest` (REST only). Versions: `semver`. Validation: `zod`. Boot-time env
  validation: `@t3-oss/env-core`.
- Tests and gates: vitest and fast-check, ESLint 10 with typescript-eslint and the sonarjs
  cognitive-complexity rule, jscpd, dependency-cruiser, Prettier.

## Options considered

- Genkit (JavaScript) instead of ADK: a capable alternative and the fallback if ADK blocks. ADK
  is the agent-first framework and is what the agent step needs.
- Next.js, SvelteKit or Remix instead of Hono: more machinery than six pages justify, slower cold
  starts on a scale-to-zero service, and less direct control over the HTML and CSS. Hono keeps the
  server small and the pages hand-built.
- `firebase-admin` instead of `@google-cloud/firestore`: bundles Auth, Realtime Database and
  Storage that this service never uses.
- A Cloud Run Job for the agent plus a separate service for the dashboard: two deploys and two
  log streams for one product. One service keeps the run and the dashboard in one place.
- Cloud Run's built-in authentication for the run endpoint: it gates the whole service, so the
  dashboard would stop being public. The app verifies the token on the one route that needs it.

## Consequences

- No client framework. Polling the run status and the "Run now" control are small scripts.
- ADK's TypeScript `outputSchema` takes a `@google/genai` schema object. zod validates tool
  parameters and re-validates the model's JSON after parsing.
- ADK for TypeScript documents only an in-memory session service, so application state lives in
  Firestore through the app's own repository layer.
- The whole run executes inside the triggering request. Cloud Run throttles CPU after a response
  on the default allocation, and Cloud Scheduler's attempt deadline is at most 30 minutes
  (default 3 minutes), so each run is bounded per repository and per candidate.
- GitHub's secondary rate limits (content-creating requests per minute) shape the actor: small
  batches, backoff on 403 and 429.

## Model lifecycle

`gemini-3.5-flash` is a family alias rather than a frozen model: Google moves what it points at and
can retire it. Pinned on 2026-08-23, when the API listed the alias as version `3.5-flash-05-2026`
with `generateContent` among its methods (`GET v1beta/models/gemini-3.5-flash`). The alias is kept
over a dated id because the free tier and the documentation follow the alias.

How drift is noticed, in order of cost:

- At boot, the service asks the API whether the exact id still resolves and logs `model listed`
  with the version it found, `model missing` when the id is gone, or `model not checked` when the
  API could not be reached. This spends no model request, which matters on a free tier that
  answers twenty a day and pays one for every cold start otherwise. A listing is not proof the
  model answers.
- The first brief of a run is the real call. A refusal is recorded on the bump with the reason the
  API gave, never as a silent gap.
- `npm run smoke:brief` is the operator's proof of life before a demo or a deploy: one real brief,
  two model requests.

Re-check the version before a public showing, and when `model missing` or a run full of refusals
appears in the log, move `BRIEF_MODEL` in `src/core/stack.ts` and re-pin here.

## What would change this decision

A blocking defect in `@google/adk` for TypeScript (switch the agent step to Genkit behind the same
`writeBrief` interface), or a dashboard that outgrows server-rendered pages (add a small islands
layer rather than a full framework).
