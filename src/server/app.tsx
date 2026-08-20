import { Hono } from 'hono';

export const SERVICE_NAME = 'bumpwarden';

export const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true, service: SERVICE_NAME }));

app.get('/', (c) =>
  c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>bumpwarden</title>
      </head>
      <body>
        <main>
          <h1>bumpwarden</h1>
          <p>
            A background agent that watches the releases of a project's dependencies, scores each
            pending bump's break risk with a published rubric, explains what would break in your
            code, and acts on GitHub. It never merges anything.
          </p>
        </main>
      </body>
    </html>,
  ),
);
