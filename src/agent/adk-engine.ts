import {
  FunctionTool,
  Gemini,
  InMemorySessionService,
  LlmAgent,
  Runner,
  isFinalResponse,
  type Event,
  type ToolUnion,
} from '@google/adk';
import { briefModelSchema } from '../core/brief.js';
import { BRIEF_MODEL, FREE_TIER_REQUESTS_PER_MINUTE } from '../core/stack.js';
import { createRequestPacer, type RequestPacer } from './pace.js';
import { briefInstruction, briefMessage, type BriefMaterial, type BriefRequest } from './prompt.js';
import { MAX_RETRY_WAIT_MS, ModelRefusal, type BriefEngine } from './write-brief.js';

/** The model the About page names, so the page and the call cannot drift apart. */
export const DEFAULT_BRIEF_MODEL = BRIEF_MODEL;

const APP_NAME = 'bumpwarden';
const USER_ID = 'bumpwarden-run';

/**
 * Large enough to hold the longest brief the schema calls legal. At 2048 a full answer ran out of
 * room mid-object and came back as text with no closing brace, which the caller could only report
 * as a missing JSON object. `adk-engine.test.ts` fails if the schema ever outgrows this. Nothing is
 * paid for room that goes unused, so the ceiling costs only what a brief actually writes.
 */
export const MAX_OUTPUT_TOKENS = 8192;

/**
 * What one brief costs at the API, measured on a live call rather than assumed: the model asks for
 * its tools in one request and writes the answer in a second. Only those two carry token usage, and
 * the tool results between them never leave the process.
 */
export const REQUESTS_PER_BRIEF = 2;

export interface AdkBriefEngineOptions {
  apiKey: string;
  model?: string;
  /** One pacer per key. A test injects one holding a clock it controls. */
  pacer?: RequestPacer;
}

export interface PacedBriefEngine extends BriefEngine {
  readonly pacer: RequestPacer;
}

/**
 * Every tool is a read over material already fetched for this bump. None of them reaches the
 * network and none of them writes anywhere, which is what makes the agent's blast radius the text
 * it returns. The architecture rule `agent-never-touches-github` keeps it that way mechanically.
 */
function readOnlyTools(material: BriefMaterial): ToolUnion[] {
  return [
    new FunctionTool({
      name: 'read_release_notes',
      description: 'The release notes published for the candidate version, as text.',
      execute: () => ({
        source: material.releaseNotesSource,
        notes: material.releaseNotes || 'no published release notes were found',
      }),
    }),
    new FunctionTool({
      name: 'read_commit_subjects',
      description: 'Commit subjects between the installed tag and the candidate tag.',
      execute: () => ({ subjects: material.commitSubjects }),
    }),
    new FunctionTool({
      name: 'read_usage_sites',
      description:
        'Lines in this repository that use a symbol the release evidence names, with file path and line number.',
      execute: () => ({ sites: material.usageSites }),
    }),
    new FunctionTool({
      name: 'read_changed_files',
      description: 'File paths the upstream diff touched between the two tags.',
      execute: () => ({ files: material.changedFiles }),
    }),
  ];
}

function textOf(event: Event): string {
  return (event.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

/** The API states its own wait inside the message, and it is the only place that number exists. */
const RETRY_HINT = /retry in ([\d.]+)s/i;

/**
 * The limit the API was enforcing, in the same sentence. Two different quotas refuse under one
 * metric name, the minute's and the day's, and only the number tells them apart.
 */
const LIMIT_HINT = /\blimit: (\d+)\b/;

interface Refusal {
  code: string;
  message: string;
}

/**
 * A refused call arrives as an error field on an event rather than as a thrown exception, and the
 * loop below would otherwise finish with an empty answer and no idea why. The free tier allows a
 * handful of model requests a minute, so this is the ordinary failure on a real queue.
 */
function refusalOf(event: Event): Refusal | null {
  const raw = event as unknown as { errorCode?: unknown; errorMessage?: unknown };
  if (typeof raw.errorCode !== 'string' || raw.errorCode.length === 0) return null;
  return {
    code: raw.errorCode,
    message: typeof raw.errorMessage === 'string' ? raw.errorMessage : 'no detail was given',
  };
}

export function retryDelayFrom(message: string): number | null {
  const seconds = Number(RETRY_HINT.exec(message)?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null;
}

export function limitFrom(message: string): number | null {
  const limit = Number(LIMIT_HINT.exec(message)?.[1]);
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

/**
 * One request to the API, seen from this side of it. A model turn reports the tokens it used, a
 * refused call reports a code instead, and a tool result reports neither because it never left the
 * process. A partial belongs to a request that was counted when it began.
 */
export function countsAsRequest(event: Event): boolean {
  if (event.partial === true) return false;
  return event.usageMetadata !== undefined || typeof event.errorCode === 'string';
}

/**
 * Everything that happens while the model works, kept out of the constructors below so it can be
 * measured against the event shapes a live call actually yields. Each request is booked with the
 * pacer as it arrives, which is the moment it was spent.
 */
export async function readRun(events: AsyncIterable<Event>, pacer: RequestPacer): Promise<string> {
  let answer = '';
  let refusal: Refusal | null = null;
  let requests = 0;

  // The runner hands back an async generator, so nothing has been sent yet: waiting here is still
  // waiting before the request rather than after it.
  const room = await pacer.clear(REQUESTS_PER_BRIEF);

  try {
    for await (const event of events) {
      if (countsAsRequest(event)) {
        requests += 1;
        room.spend(1);
      }
      refusal = refusalOf(event) ?? refusal;
      if (isFinalResponse(event)) {
        const text = textOf(event);
        if (text.length > 0) answer = text;
      }
    }

    // Counting nothing means the framework stopped saying what a call costs, not that the call was
    // free. Booking the known cost is what keeps a quiet change upstream from turning pacing off.
    if (requests === 0) room.spend(REQUESTS_PER_BRIEF);
  } finally {
    room.release();
  }

  // The minute is full for every brief in flight, not only for the one that was told so. Without
  // the hold, the others would each spend an attempt learning the same thing. A limit lower than
  // the pacer's is adopted outright: the API knows this key's allowance and the published number
  // is a reading of one day.
  const retryAfterMs = refusal ? retryDelayFrom(refusal.message) : null;
  if (retryAfterMs !== null) pacer.hold(Math.min(retryAfterMs, MAX_RETRY_WAIT_MS));
  const named = refusal ? limitFrom(refusal.message) : null;
  if (named !== null) pacer.tighten(named);

  // An answer that arrived stands even if some earlier event carried an error: what the caller
  // needs is the brief, and a refusal only matters when it is the reason there is not one.
  if (answer.length === 0 && refusal) {
    throw new ModelRefusal(refusal.code, refusal.message, retryAfterMs);
  }

  return answer;
}

/**
 * The real Gemini path. It is created from an explicit key rather than from the ambient
 * environment so that a test, a script or a second instance can never pick one up by accident.
 */
export function createAdkBriefEngine(options: AdkBriefEngineOptions): PacedBriefEngine {
  const model = options.model ?? DEFAULT_BRIEF_MODEL;
  const pacer = options.pacer ?? createRequestPacer({ limit: FREE_TIER_REQUESTS_PER_MINUTE });

  return {
    model,
    pacer,
    async generate(request: BriefRequest, material: BriefMaterial, attempt: number) {
      const agent = new LlmAgent({
        name: 'bumpwarden_brief',
        model: new Gemini({ model, apiKey: options.apiKey }),
        instruction: briefInstruction(),
        tools: readOnlyTools(material),
        outputSchema: briefModelSchema,
        // Each bump is judged on its own material; carrying history would let one package's
        // release notes colour the next package's brief.
        includeContents: 'none',
        disallowTransferToParent: true,
        disallowTransferToPeers: true,
        generateContentConfig: { temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS },
      });

      const runner = new Runner({
        appName: APP_NAME,
        agent,
        sessionService: new InMemorySessionService(),
      });

      return readRun(
        runner.runEphemeral({
          userId: USER_ID,
          newMessage: { role: 'user', parts: [{ text: briefMessage(request, material, attempt) }] },
        }),
        pacer,
      );
    },
  };
}
