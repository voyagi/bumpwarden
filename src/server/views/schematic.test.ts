import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CLOUD_REGION } from '../../core/stack.js';
import { DIAGRAM_PATH, schematicDocument } from './schematic.js';

describe('the architecture diagram', () => {
  it('matches the committed file byte for byte', async () => {
    // The About page and docs/architecture.svg are the same drawing. When this fails, the fix is
    // `npm run docs:diagram`, never editing the file by hand.
    const committed = await readFile(DIAGRAM_PATH, 'utf8');
    expect(committed).toBe(await schematicDocument());
  });

  it('stands on its own, with no stylesheet behind it', async () => {
    const svg = await schematicDocument();
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('<style>');
    expect(svg).not.toContain('var(--');
  });

  it('still says where the model branch stops', async () => {
    const svg = await schematicDocument();
    expect(svg).toContain('explanation only, no write tools');
    expect(svg).toContain(CLOUD_REGION);
  });
});
