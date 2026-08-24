# bumpwarden-demo-app

A small release-notes board: it reads markdown notes off disk, serves them over HTTP, and prints a
summary from the command line. It is a real, runnable app, and its dependencies are deliberately
out of date so that bumpwarden has honest work to do on it.

This is the repository the hosted bumpwarden instance watches, and the one the "Run now" button on
the dashboard triggers a run against.

## Run it

```sh
npm install
npm start            # http://127.0.0.1:3000
npm run report       # the command line summary
```

Endpoints: `GET /` lists the notes, `GET /notes/:slug` returns one as markdown, `GET /logo` serves
the logo, `DELETE /notes/:slug/cookie` clears the reader cookie, `POST /webhook` accepts a release
tag.

## Why the dependencies are old

Every pinned version below is a real release, and the newer version of each carries a real,
documented breaking change. They were picked so that one run over this repository produces all
three verdicts rather than a single colour.

| Package | Pinned | What breaks in the newer major |
| --- | --- | --- |
| `glob` | 7.2.3 | The `root` option is gone and `glob.sync` became `globSync`. `lib/notes.js` uses both. |
| `chalk` | 4.1.2 | ESM only from 5, `chalk.keyword` removed, and 6 needs Node 22 while this app declares 18. `report.js` uses `keyword` and `ansi256`. |
| `node-fetch` | 2.6.7 | ESM only from 3, and the `timeout` and `size` options were dropped for an AbortSignal. `lib/upstream.js` passes both. |
| `express` | 4.17.1 | 5 removed `res.sendfile` and `app.del`, both of which `server.js` calls. |
| `body-parser` | 1.20.2 | 2 drops old Node versions and changes several defaults. |
| `morgan` | 1.10.0 | A quiet minor. It is here so a run has something safe to open a pull request for. |
| `cookie-parser` | 1.4.6 | A patch. Same reason. |

Nothing here is a trap for its own sake: this is what a service looks like when nobody has touched
its dependencies for a while.

Old dependencies also mean known advisories, so this app is a fixture and a demonstration target.
Do not deploy it or point it at anything real.

## License

MIT.
