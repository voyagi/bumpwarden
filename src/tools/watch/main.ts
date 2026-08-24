import type { WatchedRepository } from '../../core/records.js';
import { FirestoreStore } from '../../io/firestore-store.js';

/**
 * Adds a repository to the watch list, which is a Firestore document and has no admin page: this
 * instance has no accounts, so there is nothing to log in to. Point it at the emulator to try it,
 * or at the project to change what the deployed service watches on its next run.
 */

const USAGE = `usage: npm run watch -- <owner>/<repo> [--ref <branch>] [--demo]

  --ref    branch or tag to read, default HEAD (the repository's default branch)
  --demo   let dashboard visitors trigger a run on it with "Run now"

Reads GOOGLE_CLOUD_PROJECT, and FIRESTORE_EMULATOR_HOST when you are running against the emulator.`;

const NAME = /^[\w.-]+\/[\w.-]+$/;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const id = argv.find((argument) => !argument.startsWith('--'));
const projectId = process.env.GOOGLE_CLOUD_PROJECT;

if (!id) fail('name the repository to watch.');
if (!NAME.test(id)) fail(`"${id}" is not an owner/repo pair.`);
if (!projectId) fail('GOOGLE_CLOUD_PROJECT is not set, so there is no store to write to.');

const [owner = '', repo = ''] = id.split('/');
const refFlag = argv.indexOf('--ref');
const repository: WatchedRepository = {
  id,
  owner,
  repo,
  ref: refFlag === -1 ? 'HEAD' : (argv[refFlag + 1] ?? 'HEAD'),
  demo: argv.includes('--demo'),
};

const store = new FirestoreStore({ projectId });
await store.putWatchedRepository(repository);

const watched = await store.listWatchedRepositories();
console.log(`watching ${watched.length} repositories in ${projectId}:`);
for (const entry of watched) {
  console.log(`  ${entry.id} at ${entry.ref}${entry.demo ? ' (demo, open to Run now)' : ''}`);
}
