import type { JSX } from 'hono/jsx/jsx-runtime';
import { SCHEDULE_CRON } from '../../core/schedule.js';
import { BRIEF_MODEL, CLOUD_REGION, NODE_MAJOR, REPOSITORY_URL } from '../../core/stack.js';
import { Schematic } from './schematic.js';

export function AboutPage(): JSX.Element {
  return (
    <>
      <section class="band">
        <h1>Where the machine stops.</h1>
        <p class="lede">
          One Cloud Run service carries both the dashboard and the run endpoint, so the scheduled
          run and the page you are reading are the same deployment. The model sits on a branch off
          the main line. It reads, it explains, and the branch ends there: it holds no GitHub tool
          and cannot reach the part that writes.
        </p>
      </section>

      <section class="wrap">
        <div class="card">
          <p class="kick">Architecture</p>
          <Schematic />
        </div>

        <div class="two" style="margin-top:26px">
          <div class="card">
            <p class="kick">Run it yourself</p>
            <div class="spinup">
              <b>git clone</b> {REPOSITORY_URL}.git &amp;&amp; <b>cd</b> bumpwarden
              <br />
              <b>cp</b> .env.example .env &nbsp;# GEMINI_API_KEY, GITHUB_TOKEN, DEMO_REPO
              <br />
              <b>npm ci</b> &amp;&amp; <b>npm run</b> dev &nbsp;# Node {NODE_MAJOR}, no cloud
              account needed
              <br />
              <b>npm run</b> deploy &nbsp;# one Cloud Run service in {CLOUD_REGION}
              <br />
              <b>schedule</b> {SCHEDULE_CRON} &nbsp;# the Cloud Scheduler job, OIDC signed
            </div>
            <p style="margin-top:16px">
              The full step by step, including the invoker service account and the Secret Manager
              entries, is in{' '}
              <a class="plain" href={`${REPOSITORY_URL}#readme`} rel="noreferrer">
                README.md
              </a>
              . With no Google Cloud project configured the service still starts and serves this
              dashboard from an in-memory store, which is how it can be read before it is deployed.
            </p>
          </div>

          <div class="card">
            <p class="kick">Where the data comes from</p>
            <p>
              <strong style="font-weight:700">GitHub REST</strong> for each watched repository's
              manifest, lockfile, releases and tag compares.
            </p>
            <p>
              <strong style="font-weight:700">npm registry</strong> for versions, publish times,
              deprecation, engines and peer ranges.
            </p>
            <p>
              <strong style="font-weight:700">deps.dev</strong> for publish time, deprecation and
              OSV advisory keys. Severity is derived from the CVSS v3 score, because the API returns
              no qualitative rating.
            </p>
            <p>
              <strong style="font-weight:700">{BRIEF_MODEL}</strong> reads that material and writes
              the explanation, through the Agent Development Kit for TypeScript, with four read only
              tools and a schema its answer has to satisfy.
            </p>
            <p style="margin-bottom:0">
              All free, no scraping. A source that cannot be read is recorded as missing and scored
              as missing, never guessed.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
