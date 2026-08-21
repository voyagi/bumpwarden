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
import { BRIEF_MODEL } from '../core/stack.js';
import { briefInstruction, briefMessage, type BriefMaterial, type BriefRequest } from './prompt.js';
import type { BriefEngine } from './write-brief.js';

/** The model the About page names, so the page and the call cannot drift apart. */
export const DEFAULT_BRIEF_MODEL = BRIEF_MODEL;

const APP_NAME = 'bumpwarden';
const USER_ID = 'bumpwarden-run';
const MAX_OUTPUT_TOKENS = 2048;

export interface AdkBriefEngineOptions {
  apiKey: string;
  model?: string;
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

/**
 * The real Gemini path. It is created from an explicit key rather than from the ambient
 * environment so that a test, a script or a second instance can never pick one up by accident.
 */
export function createAdkBriefEngine(options: AdkBriefEngineOptions): BriefEngine {
  const model = options.model ?? DEFAULT_BRIEF_MODEL;

  return {
    model,
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

      let answer = '';
      for await (const event of runner.runEphemeral({
        userId: USER_ID,
        newMessage: { role: 'user', parts: [{ text: briefMessage(request, material, attempt) }] },
      })) {
        if (isFinalResponse(event)) {
          const text = textOf(event);
          if (text.length > 0) answer = text;
        }
      }

      return answer;
    },
  };
}
