import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DIAGRAM_PATH, schematicDocument } from '../../server/views/schematic.js';

// Regenerates the architecture diagram the README and the submission use, from the component the
// About page renders, so the drawing a judge downloads and the drawing on the page cannot differ.
// Run it after touching the schematic: `npm run docs:diagram`.

const svg = await schematicDocument();
await mkdir(dirname(DIAGRAM_PATH), { recursive: true });
await writeFile(DIAGRAM_PATH, svg, 'utf8');
console.log(`wrote ${DIAGRAM_PATH} (${svg.length} bytes)`);
