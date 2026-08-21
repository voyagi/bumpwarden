import { createAdkBriefEngine } from '../agent/adk-engine.js';
import type { BriefRequest } from '../agent/prompt.js';
import { writeBrief } from '../agent/write-brief.js';
import { RUBRIC_VERSION } from '../core/rubric.js';

/**
 * One real call to Gemini, over material that is checked into this file rather than fetched.
 *
 * It exists because two things about the brief step cannot be settled by any test: whether the
 * model returns an answer this schema accepts through the agent framework's tool path, and what the
 * free tier's real rate limit is. Both are answered by running this once with a key.
 */
const NOTES = [
  '## Express 5.0.0',
  '',
  'The `res.sendfile()` function has been replaced by a camel-cased version `res.sendFile()`.',
  'Express 5 no longer supports the `app.del()` function. Use `app.delete()` instead.',
  'The `req.param(name)` helper was removed. Read from `req.params`, `req.body` or `req.query`.',
].join('\n');

const REQUEST: BriefRequest = {
  bumpKey: 'demo/app#express@5.0.0',
  repositoryId: 'demo/app',
  dependency: 'express',
  currentVersion: '4.18.2',
  candidateVersion: '5.0.0',
  band: 'red',
  score: 62,
  releaseNotes: NOTES,
  releaseNotesSource: 'https://github.com/expressjs/express/releases/tag/v5.0.0',
  commitSubjects: ['feat!: remove res.sendfile', 'feat!: drop app.del'],
  usageSites: [
    {
      path: 'src/routes/files.ts',
      line: 18,
      symbol: 'res.sendfile',
      text: 'return res.sendfile(target);',
    },
    {
      path: 'src/routes/docs.ts',
      line: 7,
      symbol: 'app.del',
      text: "app.del('/docs/:id', removeDoc);",
    },
  ],
  changedFiles: ['lib/response.js', 'lib/application.js'],
};

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set. Put it in .env or set it in this shell, then retry.');
    process.exitCode = 1;
    return;
  }

  const engine = createAdkBriefEngine({ apiKey });
  console.log(`asking ${engine.model} for one brief on express 4.18.2 to 5.0.0`);

  const started = Date.now();
  const brief = await writeBrief(REQUEST, {
    engine,
    rubricVersion: RUBRIC_VERSION,
    now: new Date(),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nstatus     ${brief.status} after ${brief.attempts} attempt(s), ${seconds}s`);
  console.log(`model      ${brief.model}`);
  console.log(`truncated  ${brief.truncated}`);
  console.log(`dropped    ${brief.droppedClaims} claim(s) the release notes did not support`);

  if (brief.status !== 'ready' || !brief.content) {
    console.error(`\nno brief: ${brief.reason ?? 'no reason recorded'}`);
    process.exitCode = 1;
    return;
  }

  const content = brief.content;
  console.log(`\n${content.headline}\n${content.whatChanged}`);
  console.log(`\nbreaks here (${content.breaksHere.length}):`);
  for (const claim of content.breaksHere) {
    const mark = claim.verified ? 'verified' : 'unverified';
    console.log(`  ${claim.path}:${claim.line} ${claim.symbol} [${mark}]`);
    console.log(`    "${claim.quote}"`);
  }
  console.log(`\nmigration: ${content.migrationSteps.join(' ')}`);
  console.log(`confidence: ${content.confidence}`);
}

await main();
