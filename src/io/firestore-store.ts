import { Firestore, type CollectionReference, type Query } from '@google-cloud/firestore';
import type { BriefRecord } from '../core/brief.js';
import { documentId } from '../core/bump-key.js';
import {
  projectSummaryFor,
  type ActionRecord,
  type BumpRecord,
  type ProjectSummary,
  type RunRecord,
  type WatchedRepository,
} from '../core/records.js';
import type { ActionQuery, BumpQuery, BumpwardenStore } from './store.js';

const PROJECTS = 'projects';
const RUNS = 'runs';
const ACTIONS = 'actions';
const BRIEFS = 'briefs';
const BUMPS = 'bumps';

/**
 * Both list queries read one bounded page and filter in memory. Filtering server side would need a
 * composite index per filter, and a missing index fails a deployed query at request time rather
 * than at deploy time. A single-operator instance never has enough rows for that trade to matter.
 */
const MAX_QUEUE = 200;
const MAX_AUDIT = 200;

export interface FirestoreStoreOptions {
  projectId: string;
  /**
   * True when FIRESTORE_EMULATOR_HOST points the client at a local emulator. The entry point owns
   * reading that, so this class stays free of the environment.
   */
  emulated?: boolean;
  /** Injected in tests; production builds its own client. */
  client?: Firestore;
}

function documents<T>(snapshot: { docs: Array<{ data(): unknown }> }): T[] {
  return snapshot.docs.map((doc) => doc.data() as T);
}

export class FirestoreStore implements BumpwardenStore {
  private readonly db: Firestore;

  constructor(options: FirestoreStoreOptions) {
    // preferRest keeps a cold Cloud Run container from loading gRPC for what are all small reads
    // and writes. It cannot be used against the emulator: preferRest routes through google-gax,
    // which asks for application default credentials before it looks at FIRESTORE_EMULATOR_HOST,
    // so a local run dies on "Could not load the default credentials" instead of connecting.
    this.db =
      options.client ??
      new Firestore({
        projectId: options.projectId,
        ignoreUndefinedProperties: true,
        preferRest: !options.emulated,
      });
  }

  private projectDoc(repositoryId: string) {
    return this.db.collection(PROJECTS).doc(documentId(repositoryId));
  }

  private bumpsOf(repositoryId: string): CollectionReference {
    return this.projectDoc(repositoryId).collection(BUMPS);
  }

  async listWatchedRepositories(): Promise<WatchedRepository[]> {
    const summaries = await this.listProjectSummaries();
    return summaries.map((summary) => summary.repository);
  }

  async putWatchedRepository(repository: WatchedRepository): Promise<void> {
    const doc = this.projectDoc(repository.id);
    const snapshot = await doc.get();
    const existing = snapshot.exists ? (snapshot.data() as ProjectSummary) : null;
    await doc.set(projectSummaryFor(repository, existing));
  }

  async saveRun(run: RunRecord): Promise<void> {
    await this.db.collection(RUNS).doc(run.id).set(run);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const snapshot = await this.db.collection(RUNS).doc(id).get();
    return snapshot.exists ? (snapshot.data() as RunRecord) : null;
  }

  async listRuns(limit: number): Promise<RunRecord[]> {
    const snapshot = await this.db.collection(RUNS).orderBy('startedAt', 'desc').limit(limit).get();
    return documents<RunRecord>(snapshot);
  }

  async saveBump(bump: BumpRecord): Promise<void> {
    await this.bumpsOf(bump.repositoryId).doc(documentId(bump.key)).set(bump);
  }

  async getBump(repositoryId: string, key: string): Promise<BumpRecord | null> {
    const snapshot = await this.bumpsOf(repositoryId).doc(documentId(key)).get();
    return snapshot.exists ? (snapshot.data() as BumpRecord) : null;
  }

  async listBumps(query: BumpQuery): Promise<BumpRecord[]> {
    const page: Query = this.bumpsOf(query.repositoryId)
      .orderBy('score.total', 'desc')
      .limit(MAX_QUEUE);
    const snapshot = await page.get();

    return documents<BumpRecord>(snapshot)
      .filter((bump) => query.band === undefined || bump.score.band === query.band)
      .slice(0, query.limit);
  }

  async appendAction(action: ActionRecord): Promise<void> {
    await this.db.collection(ACTIONS).doc(documentId(action.id)).set(action);
  }

  async listActions(query: ActionQuery): Promise<ActionRecord[]> {
    const snapshot = await this.db.collection(ACTIONS).orderBy('at', 'desc').limit(MAX_AUDIT).get();

    return documents<ActionRecord>(snapshot)
      .filter(
        (action) => query.repositoryId === undefined || action.repositoryId === query.repositoryId,
      )
      .slice(0, query.limit);
  }

  async getBrief(cacheKey: string): Promise<BriefRecord | null> {
    const snapshot = await this.db.collection(BRIEFS).doc(documentId(cacheKey)).get();
    return snapshot.exists ? (snapshot.data() as BriefRecord) : null;
  }

  async putBrief(record: BriefRecord): Promise<void> {
    await this.db.collection(BRIEFS).doc(documentId(record.cacheKey)).set(record);
  }

  async putProjectSummary(summary: ProjectSummary): Promise<void> {
    await this.projectDoc(summary.repository.id).set(summary, { merge: true });
  }

  async listProjectSummaries(): Promise<ProjectSummary[]> {
    const snapshot = await this.db.collection(PROJECTS).orderBy('repository.id').get();
    return documents<ProjectSummary>(snapshot);
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }
}
