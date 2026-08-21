// Architecture boundaries. The rule file is the documented layering, enforced on every commit and in CI.
//
// src/core          pure: rubric, scorer, policy, types. No network, no SDKs, no other layer.
// src/io            one client per external boundary (GitHub, npm registry, deps.dev, Firestore).
// src/agent         the only Gemini/ADK touchpoint. It receives data and returns a brief. It may not
//                   import the GitHub client: the model must never hold a path to a GitHub write.
// src/orchestrator  sequences fetch, resolve, score, brief, policy, act, persist.
// src/server        Hono routes and pages. Reads through io, triggers the orchestrator.
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  forbidden: [
    {
      name: 'core-stays-pure',
      severity: 'error',
      comment:
        'core/ must not depend on io, agent, orchestrator or server. Determinism is proven by construction.',
      from: { path: '^src/core' },
      to: { path: '^src/(io|agent|orchestrator|server)' },
    },
    {
      name: 'agent-never-touches-github',
      severity: 'error',
      comment: 'agent/ must not import the GitHub client: the model explains, it never acts.',
      from: { path: '^src/agent' },
      to: { path: '^src/io/github' },
    },
    {
      name: 'io-does-not-know-server',
      severity: 'error',
      comment: 'io/ clients must not import server code.',
      from: { path: '^src/io' },
      to: { path: '^src/(server|orchestrator)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make code hard to reason about, test, and tree-shake.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules (imported by nothing) are usually dead code. Confirm or delete.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)(index|main|entry)\\.[jt]sx?$',
          '\\.config\\.[jt]s$',
          '\\.test\\.[jt]sx?$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Without this, a type-only import is invisible, so a module every layer imports types from
    // reads as an orphan, and a boundary crossed by `import type` is never caught.
    tsPreCompilationDeps: true,
    ...(fs.existsSync(path.join(__dirname, 'tsconfig.json'))
      ? { tsConfig: { fileName: path.join(__dirname, 'tsconfig.json') } }
      : {}),
    enhancedResolveOptions: { extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'] },
  },
};
