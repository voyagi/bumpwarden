import type { BriefRecord } from '../core/brief.js';
import {
  projectSummaryFor,
  type ActionRecord,
  type BumpRecord,
  type ProjectSummary,
  type RunRecord,
  type WatchedRepository,
} from '../core/records.js';
import type { ActionQuery, BumpQuery, BumpwardenStore } from './store.js';

function copy<T>(value: T): T {
  return structuredClone(value);
}

function newestFirst<T>(items: T[], at: (item: T) => string): T[] {
  return [...items].sort((left, right) => at(right).localeCompare(at(left)));
}

/**
 * The store the test suite and a credential-free local run use. It is deliberately part of the
 * shipped code rather than a test fixture: `npm run dev` with no Google Cloud project has to start
 * and serve an empty dashboard, and a fallback that only exists in tests is a fallback nobody runs.
 */
export class MemoryStore implements BumpwardenStore {
  private readonly projects = new Map<string, ProjectSummary>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly bumps = new Map<string, BumpRecord>();
  private readonly actions = new Map<string, ActionRecord>();
  private readonly briefs = new Map<string, BriefRecord>();

  async listWatchedRepositories(): Promise<WatchedRepository[]> {
    return [...this.projects.values()].map((summary) => copy(summary.repository));
  }

  async putWatchedRepository(repository: WatchedRepository): Promise<void> {
    const existing = this.projects.get(repository.id) ?? null;
    this.projects.set(repository.id, projectSummaryFor(copy(repository), existing));
  }

  async saveRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, copy(run));
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const run = this.runs.get(id);
    return run ? copy(run) : null;
  }

  async listRuns(limit: number): Promise<RunRecord[]> {
    return newestFirst([...this.runs.values()], (run) => run.startedAt)
      .slice(0, limit)
      .map(copy);
  }

  async saveBump(bump: BumpRecord): Promise<void> {
    this.bumps.set(`${bump.repositoryId}|${bump.key}`, copy(bump));
  }

  async getBump(repositoryId: string, key: string): Promise<BumpRecord | null> {
    const bump = this.bumps.get(`${repositoryId}|${key}`);
    return bump ? copy(bump) : null;
  }

  async listBumps(query: BumpQuery): Promise<BumpRecord[]> {
    const matching = [...this.bumps.values()].filter(
      (bump) =>
        bump.repositoryId === query.repositoryId &&
        (query.band === undefined || bump.score.band === query.band),
    );
    return [...matching]
      .sort((left, right) => right.score.total - left.score.total)
      .slice(0, query.limit)
      .map(copy);
  }

  async appendAction(action: ActionRecord): Promise<void> {
    this.actions.set(action.id, copy(action));
  }

  async listActions(query: ActionQuery): Promise<ActionRecord[]> {
    const matching = [...this.actions.values()].filter(
      (action) => query.repositoryId === undefined || action.repositoryId === query.repositoryId,
    );
    return newestFirst(matching, (action) => action.at)
      .slice(0, query.limit)
      .map(copy);
  }

  async getBrief(cacheKey: string): Promise<BriefRecord | null> {
    const brief = this.briefs.get(cacheKey);
    return brief ? copy(brief) : null;
  }

  async putBrief(record: BriefRecord): Promise<void> {
    this.briefs.set(record.cacheKey, copy(record));
  }

  async putProjectSummary(summary: ProjectSummary): Promise<void> {
    this.projects.set(summary.repository.id, copy(summary));
  }

  async listProjectSummaries(): Promise<ProjectSummary[]> {
    return [...this.projects.values()]
      .sort((left, right) => left.repository.id.localeCompare(right.repository.id))
      .map(copy);
  }
}
