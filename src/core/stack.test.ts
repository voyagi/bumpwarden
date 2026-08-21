import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PER_RUN_BUDGETS, POLICY_RULES, RUN_TIME_BUDGET_SECONDS } from './policy.js';
import { BAND_RANGES } from './rubric.js';
import { SCHEDULE_CRON } from './schedule.js';
import { BRIEF_MODEL, CLOUD_REGION, NODE_MAJOR } from './stack.js';

/**
 * The README is the reproducibility claim: someone reads it and expects the commands to match the
 * service. These pin the parts of it that are also constants, so a changed schedule or region
 * cannot leave a document quietly promising the old one.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (name: string): string => readFileSync(`${ROOT}${name}`, 'utf8');

const dockerfile = read('Dockerfile');
const readme = read('README.md');
const nodeVersion = read('.node-version').trim();

describe('the container image', () => {
  it('runs the Node version this repository is built against', () => {
    const tags = [...dockerfile.matchAll(/^FROM node:([\d.]+)-/gm)].map((match) => match[1]);

    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toBe(nodeVersion);
    expect(nodeVersion.startsWith(`${NODE_MAJOR}.`)).toBe(true);
  });

  it('pins every base image by digest, so a rebuild gets the image the deploy was tested on', () => {
    const froms = [...dockerfile.matchAll(/^FROM \S+/gm)].map((match) => match[0]);

    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) expect(from).toContain('@sha256:');
  });
});

describe('the README', () => {
  it('deploys to the region the About page and the diagram name', () => {
    expect(readme).toContain(CLOUD_REGION);
  });

  it('creates the scheduler job with the cron the dashboard counts down to', () => {
    expect(readme).toContain(`--schedule "${SCHEDULE_CRON}"`);
  });

  it('names the model the agent actually calls', () => {
    expect(readme).toContain(BRIEF_MODEL);
  });

  it('publishes the band edges the scorer uses', () => {
    for (const range of Object.values(BAND_RANGES)) expect(readme).toContain(range);
  });

  it('publishes the rule ids and the per-run budgets the run obeys', () => {
    for (const rule of Object.values(POLICY_RULES)) expect(readme).toContain(rule.id);
    expect(readme).toContain(`at most ${PER_RUN_BUDGETS.briefs} briefs`);
    expect(readme).toContain(`at most ${PER_RUN_BUDGETS.actions} actions`);
    expect(readme).toContain(`a ${RUN_TIME_BUDGET_SECONDS / 60} minute deadline`);
  });
});
