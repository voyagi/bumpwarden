import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import { POLICY_VERSION } from '../core/policy.js';
import {
  ZERO_COUNTS,
  addCounts,
  countBands,
  type BandCounts,
  type ProjectSummary,
} from '../core/records.js';
import { projectPath } from '../core/routes.js';
import { RUBRIC_VERSION } from '../core/rubric.js';
import { nextScheduledRun } from '../core/schedule.js';
import { BRIEF_MODEL, CLOUD_REGION, NODE_MAJOR } from '../core/stack.js';
import type { Band } from '../core/types.js';
import { log } from '../io/log.js';
import type { BumpwardenStore } from '../io/store.js';
import { RUN_LOOKBACK, REFUSAL_STATUS, runNowStatus } from './run-now.js';
import type { StartRun } from './start-run.js';
import { auditFeed, utcDate, utcStamp, utcTime } from './view-model.js';
import { AboutPage } from './views/about.js';
import { AuditPage } from './views/audit.js';
import { BumpPage } from './views/bump.js';
import { HomePage } from './views/home.js';
import { Shell, type ShellOptions } from './views/layout.js';
import { PolicyPage } from './views/policy.js';
import { QueuePage } from './views/queue.js';
import { StatePanel } from './views/states.js';

/** One bounded page per query. A single-operator instance never has more than this pending. */
const QUEUE_LIMIT = 200;
const AUDIT_ROWS = 80;
const LATEST_ACTIONS = 4;
const CONTEXT_BUMPS = 6;

export interface DashboardOptions {
  store: BumpwardenStore;
  now: () => Date;
  startRun: StartRun | null;
  /** The public origin, when one is configured, so canonical urls survive a proxy. */
  baseUrl?: string | null;
}

const BANDS: Band[] = ['green', 'amber', 'red'];

function parseBand(value: string | undefined): Band | null {
  return BANDS.find((band) => band === value) ?? null;
}

function origin(c: Context, configured: string | null | undefined): string {
  if (configured) return configured.replace(/\/+$/, '');

  const url = new URL(c.req.url);
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwarded) url.protocol = `${forwarded}:`;
  return url.origin;
}

function scheduleMeta(now: Date): string {
  return `rubric v${RUBRIC_VERSION} · next run ${utcTime(nextScheduledRun(now).toISOString())} UTC`;
}

/** The Queue nav item points at the project in hand, or at the demo project when there is none. */
function primaryQueueHref(projects: ProjectSummary[]): string {
  const demo = projects.find((project) => project.repository.demo) ?? projects[0];
  return demo ? projectPath(demo.repository.id) : '/';
}

function totalsOf(projects: ProjectSummary[]): BandCounts {
  return projects.reduce<BandCounts>((running, project) => addCounts(running, project.counts), {
    ...ZERO_COUNTS,
  });
}

type PageOptions = Omit<ShellOptions, 'canonical'>;

function render(c: Context, options: PageOptions, baseUrl: string | null | undefined) {
  const canonical = `${origin(c, baseUrl)}${new URL(c.req.url).pathname}`;
  // A dashboard that answers from a cache can show a run as pending after it finished, which is
  // exactly the moment a visitor is watching it.
  c.header('Cache-Control', 'no-store');
  return c.html(html`<!doctype html>${Shell({ ...options, canonical })}`);
}

function notFound(c: Context, baseUrl: string | null | undefined, queueHref: string) {
  const canonical = `${origin(c, baseUrl)}${new URL(c.req.url).pathname}`;
  c.header('Cache-Control', 'no-store');
  return c.html(
    html`<!doctype html>${Shell({
        title: 'Not found',
        description: 'That page is not part of this bumpwarden instance.',
        current: 'home',
        queueHref,
        meta: `rubric v${RUBRIC_VERSION}`,
        canonical,
        body: (
          <StatePanel
            heading="There is nothing at that address."
            lines={[
              'A repository is only readable here while it is on the watch list, and a bump only while its candidate version is still the newest one resolved. Both disappear from the dashboard when they stop being true, which is deliberate: a page showing a bump that no longer exists would be a page telling you something false.',
              'The rubric and the action policy are published whether or not any run has happened, so they are always a safe place to land.',
            ]}
            action={{ label: 'Read the published rubric', href: '/rubric' }}
          />
        ),
      })}`,
    404,
  );
}

function failed(c: Context, baseUrl: string | null | undefined, error: Error) {
  const canonical = `${origin(c, baseUrl)}${new URL(c.req.url).pathname}`;
  // Logged in full, shown as a sentence: a stack trace on a public dashboard tells a stranger more
  // about the deployment than it tells the operator, who has the logs.
  log.error('page failed', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    error,
  });
  c.header('Cache-Control', 'no-store');
  return c.html(
    html`<!doctype html>${Shell({
        title: 'Something failed',
        description: 'This page could not be built from the store.',
        current: 'home',
        queueHref: '/',
        meta: `rubric v${RUBRIC_VERSION}`,
        canonical,
        body: (
          <StatePanel
            heading="This page could not be built."
            lines={[
              'Something between the dashboard and its store went wrong while assembling this page. The run itself is unaffected: runs are triggered by the scheduler and write their results before anything renders them, so nothing has been lost by this failing.',
              'The reason is in the service logs rather than on this page, because a stack trace here would describe the deployment to anyone who asked for it.',
            ]}
            action={{ label: 'Back to the watched repositories', href: '/' }}
          />
        ),
      })}`,
    500,
  );
}

function mountHome(app: Hono, options: DashboardOptions): void {
  app.get('/', async (c) => {
    const projects = await options.store.listProjectSummaries();
    const actions = await options.store.listActions({ limit: LATEST_ACTIONS });
    // Worst first. The whole point of the page is to say what needs a person, so the repository
    // that needs one cannot be below the fold behind an alphabetically luckier quiet one.
    const ranked = [...projects].sort(
      (left, right) =>
        right.worstScore - left.worstScore || left.repository.id.localeCompare(right.repository.id),
    );

    return render(
      c,
      {
        title: 'bumpwarden',
        description:
          'A background agent that scores every pending dependency bump against a published rubric, explains what would break in your code, and acts on GitHub without ever merging.',
        current: 'home',
        queueHref: primaryQueueHref(projects),
        meta: scheduleMeta(options.now()),
        body: <HomePage projects={ranked} actions={actions} totals={totalsOf(projects)} />,
      },
      options.baseUrl,
    );
  });
}

function mountQueue(app: Hono, options: DashboardOptions): void {
  app.get('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const projects = await options.store.listProjectSummaries();
    const project = projects.find((entry) => entry.repository.id === id);
    if (!project) return notFound(c, options.baseUrl, primaryQueueHref(projects));

    const all = await options.store.listBumps({ repositoryId: id, limit: QUEUE_LIMIT });
    const band = parseBand(c.req.query('verdict'));
    const lastRun = project.lastRunId ? await options.store.getRun(project.lastRunId) : null;
    const runs = await options.store.listRuns(RUN_LOOKBACK);

    return render(
      c,
      {
        title: project.repository.id,
        description: `The bump queue for ${project.repository.id}: every pending dependency update, scored 0 to 100 against bumpwarden's published rubric.`,
        current: 'queue',
        queueHref: projectPath(id),
        meta: scheduleMeta(options.now()),
        script: '/run-now.js',
        body: (
          <QueuePage
            project={project}
            counts={countBands(all.map((bump) => bump.score.band))}
            lastRun={lastRun}
            bumps={band ? all.filter((bump) => bump.score.band === band) : all}
            all={all}
            band={band}
            runNow={runNowStatus(project.repository, runs, options.now())}
            missing={
              lastRun?.repositories.find((result) => result.repositoryId === id)?.missing ?? []
            }
          />
        ),
      },
      options.baseUrl,
    );
  });
}

function mountBump(app: Hono, options: DashboardOptions): void {
  app.get('/projects/:id/bumps/:key', async (c) => {
    const id = c.req.param('id');
    const key = c.req.param('key');
    const projects = await options.store.listProjectSummaries();
    const bump = await options.store.getBump(id, key);
    if (!bump) return notFound(c, options.baseUrl, primaryQueueHref(projects));

    const context = await options.store.listBumps({ repositoryId: id, limit: CONTEXT_BUMPS });
    const actions = await options.store.listActions({ repositoryId: id, limit: AUDIT_ROWS });

    return render(
      c,
      {
        title: `${bump.dependency} ${bump.currentVersion} to ${bump.candidateVersion}`,
        description: `Why bumpwarden scored ${bump.dependency} ${bump.candidateVersion} at ${bump.score.total} of 100 for ${bump.repositoryId}, factor by factor, with the evidence for each.`,
        current: 'queue',
        queueHref: projectPath(id),
        meta: `rubric v${bump.score.rubricVersion} · scored ${utcStamp(bump.updatedAt)} UTC`,
        body: (
          <BumpPage
            bump={bump}
            context={context}
            actions={actions.filter((action) => action.bumpKey === key)}
          />
        ),
      },
      options.baseUrl,
    );
  });
}

function mountAudit(app: Hono, options: DashboardOptions): void {
  app.get('/audit', async (c) => {
    const projects = await options.store.listProjectSummaries();
    const runs = await options.store.listRuns(AUDIT_ROWS);
    const actions = await options.store.listActions({ limit: AUDIT_ROWS });
    const rows = auditFeed(runs, actions, AUDIT_ROWS);
    const since = rows.length > 0 ? utcDate(rows[rows.length - 1]?.at ?? null) : null;

    return render(
      c,
      {
        title: 'Audit log',
        description:
          'Every issue, pull request and comment bumpwarden opened, newest first, each with the policy rule that fired it and the run it belonged to.',
        current: 'audit',
        queueHref: primaryQueueHref(projects),
        meta: since ? `${rows.length} entries since ${since}` : 'no entries yet',
        body: <AuditPage rows={rows} />,
      },
      options.baseUrl,
    );
  });
}

function mountPublished(app: Hono, options: DashboardOptions): void {
  app.get('/rubric', async (c) => {
    const projects = await options.store.listProjectSummaries();
    return render(
      c,
      {
        title: 'The rubric',
        description: `bumpwarden's published scoring rubric v${RUBRIC_VERSION} and action policy v${POLICY_VERSION}: every factor, its weight, its source, and what happens in each band.`,
        current: 'rubric',
        queueHref: primaryQueueHref(projects),
        meta: `rubric v${RUBRIC_VERSION} · policy v${POLICY_VERSION}`,
        body: <PolicyPage />,
      },
      options.baseUrl,
    );
  });

  app.get('/about', async (c) => {
    const projects = await options.store.listProjectSummaries();
    return render(
      c,
      {
        title: 'How it is built',
        description:
          'The architecture behind bumpwarden: Cloud Scheduler, one Cloud Run service, Firestore, and a Gemini agent that explains but never writes.',
        current: 'about',
        queueHref: primaryQueueHref(projects),
        meta: `${CLOUD_REGION} · ${BRIEF_MODEL} · Node ${NODE_MAJOR}`,
        body: <AboutPage />,
      },
      options.baseUrl,
    );
  });
}

function mountRunNow(app: Hono, options: DashboardOptions): void {
  app.get('/projects/:id/run-status', async (c) => {
    const id = c.req.param('id');
    const projects = await options.store.listProjectSummaries();
    const project = projects.find((entry) => entry.repository.id === id);
    const runs = await options.store.listRuns(RUN_LOOKBACK);

    c.header('Cache-Control', 'no-store');
    return c.json(runNowStatus(project?.repository ?? null, runs, options.now()));
  });

  app.post('/projects/:id/run', async (c) => {
    const id = c.req.param('id');
    const projects = await options.store.listProjectSummaries();
    const project = projects.find((entry) => entry.repository.id === id);
    const runs = await options.store.listRuns(RUN_LOOKBACK);
    const status = runNowStatus(project?.repository ?? null, runs, options.now());

    if (status.state !== 'ready') {
      if (status.retryAfterSeconds > 0) c.header('Retry-After', String(status.retryAfterSeconds));
      return c.json(status, REFUSAL_STATUS[status.state]);
    }
    if (!options.startRun) {
      return c.json({ ...status, state: 'unavailable', message: 'no run pipeline is wired' }, 503);
    }

    // Awaited rather than started and forgotten: Cloud Run stops giving a container CPU once the
    // response is sent, so a run left in flight behind the response would freeze mid-request.
    const run = await options.startRun({ trigger: 'manual', repositoryId: id });

    if (c.req.header('accept')?.includes('application/json')) {
      return c.json({ runId: run.id, status: run.status, counts: run.counts });
    }
    return c.redirect(projectPath(id), 303);
  });
}

function mountSitemap(app: Hono, options: DashboardOptions): void {
  app.get('/sitemap.xml', async (c) => {
    const base = origin(c, options.baseUrl);
    const projects = await options.store.listProjectSummaries();
    const paths = [
      '/',
      '/audit',
      '/rubric',
      '/about',
      ...projects.map((p) => projectPath(p.repository.id)),
    ];
    const entries = paths.map((path) => `  <url><loc>${base}${path}</loc></url>`).join('\n');

    c.header('Content-Type', 'application/xml; charset=utf-8');
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`,
    );
  });
}

/**
 * Every page reads through the store interface and nothing else, so the whole dashboard runs
 * against the in-memory store with no credentials at all. That is what makes it provable before a
 * Google Cloud project exists, and what keeps a page from quietly depending on Firestore.
 */
export function mountDashboard(app: Hono, options: DashboardOptions): void {
  mountRunNow(app, options);
  mountQueue(app, options);
  mountBump(app, options);
  mountAudit(app, options);
  mountPublished(app, options);
  mountSitemap(app, options);
  mountHome(app, options);

  app.notFound((c) => notFound(c, options.baseUrl, '/'));
  app.onError((error, c) => failed(c, options.baseUrl, error));
}

export { notFound as renderNotFound };
