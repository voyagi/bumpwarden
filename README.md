# bumpwarden

A background agent that watches the releases of a project's dependencies, scores every pending
bump's break risk with a published, deterministic rubric, has Gemini explain what would break in
your code, and then acts on GitHub: a pull request for a safe bump, an issue for a risky one, a
hold for a dangerous one. It never merges anything.

Dependabot and Renovate bump. bumpwarden judges, explains, and acts, with a score you can read.

Status: in development.

## How it works

1. On a schedule (Cloud Scheduler) or on request, the agent reads each watched repository's
   manifest and lockfile from GitHub.
2. It resolves candidate versions from the npm registry and Google's deps.dev API, and collects
   the release notes, the diff between tags and any advisories.
3. A pure scoring function turns that evidence into a 0-100 break-risk score. The rubric is
   published and versioned, so the verdict is reproducible.
4. An agent built with the Google Agent Development Kit asks Gemini 3.5 Flash to write a brief:
   what changed, what breaks here (with file and line evidence), how to migrate, and how sure it is.
5. A fixed policy maps the score band to an action on GitHub. Every action lands in an audit log.

## Stack

- Gemini 3.5 Flash through the Gemini API
- Google Agent Development Kit for TypeScript (`@google/adk`)
- Cloud Run (one service: dashboard and run endpoint), Cloud Scheduler, Firestore
- Node 24, TypeScript, Hono

## Run locally

1. Install Node 24.13 or newer (`.node-version` pins 24.19.0).
2. `npm install`
3. Copy `.env.example` to `.env` and fill in what you have. The health probe needs nothing.
4. `npm run dev`, then open http://127.0.0.1:8080/healthz

## Quality gates

`npm run verify:ship` runs the typecheck, the full test suite, whole-repo lint and the gate chain
(complexity, duplicated logic, architecture boundaries) and prints one exit code per step.

## License

MIT, see [LICENSE](LICENSE).
