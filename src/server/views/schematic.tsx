import type { JSX } from 'hono/jsx/jsx-runtime';
import { RUBRIC_VERSION } from '../../core/rubric.js';
import { SCHEDULE_UTC_HOURS } from '../../core/schedule.js';
import { BRIEF_MODEL, CLOUD_REGION } from '../../core/stack.js';

const SCHEDULE_LABEL = SCHEDULE_UTC_HOURS.map((hour) => `${String(hour).padStart(2, '0')}:00`).join(
  ' and ',
);

const DESCRIPTION = [
  'Cloud Scheduler calls the Cloud Run run endpoint with an OIDC token.',
  'The endpoint fetches from GitHub, the npm registry and deps.dev, scores each bump deterministically,',
  `and sends the release notes to an agent on ${BRIEF_MODEL}. That branch ends at the explanation.`,
  'Policy turns the score into a GitHub action, and everything is written to Firestore, which the dashboard reads.',
].join(' ');

/**
 * The light palette from public/bumpwarden.css, inlined for the copy that leaves the app. A file
 * in docs/ has no stylesheet behind it and is read by GitHub and by a submission form, so it has
 * to carry its own paint. `schematic.test.ts` fails if the committed file stops matching this.
 */
const STANDALONE_STYLE = [
  'text{font-family:"Mona Sans",sans-serif;fill:#14181b}',
  '.cap{font-size:12px;font-weight:600}',
  '.sub{font-size:10.5px;fill:#6b747a;font-family:"JetBrains Mono",monospace}',
  '.box{fill:none;stroke:#5a6469;stroke-width:1.5;rx:6}',
  '.line{stroke:#5a6469;stroke-width:1.5;fill:none}',
  '.zone{fill:none;stroke:#e6e8e7;stroke-width:1.5;stroke-dasharray:6 5;rx:10}',
  '.stopmark{stroke:#b91c1c;stroke-width:3.5}',
].join('');

export interface SchematicProps {
  /** Set for the copy written to docs/, which has no stylesheet and no page around it. */
  standalone?: boolean;
}

/**
 * The one drawn image in the product. Its single coloured mark is the bar across the agent box,
 * because that mark IS a risk statement: the model branch ends at the explanation and no path
 * leads from it to the part that writes to GitHub.
 */
export function Schematic(props: SchematicProps = {}): JSX.Element {
  return (
    <svg
      class="schematic"
      viewBox="0 0 1000 400"
      role="img"
      aria-label={DESCRIPTION}
      {...(props.standalone
        ? { xmlns: 'http://www.w3.org/2000/svg', width: '1000', height: '400' }
        : {})}
    >
      {props.standalone ? <style>{STANDALONE_STYLE}</style> : null}
      <rect class="box" x="272" y="18" width="150" height="48" />
      <text class="cap" x="286" y="40">
        GitHub REST
      </text>
      <text class="sub" x="286" y="56">
        manifest, releases
      </text>
      <rect class="box" x="500" y="18" width="168" height="48" />
      <text class="cap" x="514" y="40">
        npm and deps.dev
      </text>
      <text class="sub" x="514" y="56">
        versions, advisories
      </text>

      <rect class="zone" x="150" y="98" width="700" height="212" />
      <text class="sub" x="164" y="118">
        Cloud Run, {CLOUD_REGION}
      </text>

      <rect class="box" x="14" y="164" width="122" height="50" />
      <text class="cap" x="28" y="186">
        Cloud Scheduler
      </text>
      <text class="sub" x="28" y="202">
        {SCHEDULE_LABEL}
      </text>
      <path class="line" d="M136 189 H196" />
      <path class="line" d="M188 184 l9 5 -9 5 z" fill="currentColor" />
      <text class="sub" x="142" y="181">
        OIDC
      </text>

      <rect class="box" x="196" y="164" width="124" height="50" />
      <text class="cap" x="210" y="186">
        Run endpoint
      </text>
      <text class="sub" x="210" y="202">
        token verified
      </text>

      <path class="line" d="M320 189 H362" />
      <path class="line" d="M354 184 l9 5 -9 5 z" fill="currentColor" />

      <rect class="box" x="362" y="164" width="114" height="50" />
      <text class="cap" x="376" y="186">
        Ingest
      </text>
      <text class="sub" x="376" y="202">
        cached per run
      </text>

      <path class="line" d="M419 164 V82 H347 V66" />
      <path class="line" d="M419 82 H584 V66" />

      <path class="line" d="M476 189 H518" />
      <path class="line" d="M510 184 l9 5 -9 5 z" fill="currentColor" />

      <rect class="box" x="518" y="164" width="150" height="50" />
      <text class="cap" x="532" y="186">
        Deterministic scorer
      </text>
      <text class="sub" x="532" y="202">
        rubric v{RUBRIC_VERSION}
      </text>

      <path class="line" d="M593 214 V262 H466" />
      <rect class="box" x="340" y="238" width="126" height="48" />
      <text class="cap" x="352" y="260">
        Agent
      </text>
      <text class="sub" x="352" y="276">
        {BRIEF_MODEL}
      </text>
      <path class="stopmark" d="M334 238 V286" />
      <text class="sub" x="340" y="304">
        explanation only, no write tools
      </text>

      <path class="line" d="M668 189 H710" />
      <path class="line" d="M702 184 l9 5 -9 5 z" fill="currentColor" />

      <rect class="box" x="710" y="164" width="130" height="50" />
      <text class="cap" x="724" y="186">
        Policy and actor
      </text>
      <text class="sub" x="724" y="202">
        never merges
      </text>

      <path class="line" d="M840 189 H884" />
      <path class="line" d="M876 184 l9 5 -9 5 z" fill="currentColor" />
      <rect class="box" x="884" y="164" width="110" height="50" />
      <text class="cap" x="898" y="186">
        GitHub
      </text>
      <text class="sub" x="898" y="202">
        issues, PRs
      </text>

      <path class="line" d="M800 214 V352 H700" />
      <rect class="box" x="556" y="328" width="144" height="48" />
      <text class="cap" x="570" y="350">
        Firestore
      </text>
      <text class="sub" x="570" y="366">
        runs and actions
      </text>

      <path class="line" d="M556 352 H240 V214" />
      <path class="line" d="M235 222 l5 -9 5 9 z" fill="currentColor" />
      <text class="sub" x="250" y="372">
        the dashboard reads the same store
      </text>
    </svg>
  );
}

/** Where the generated copy lives, named once so the writer and its test cannot disagree. */
export const DIAGRAM_PATH = 'docs/architecture.svg';

/** The exact bytes docs/architecture.svg must hold. One source, two destinations. */
export async function schematicDocument(): Promise<string> {
  const svg = await Schematic({ standalone: true }).toString();
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;
}
