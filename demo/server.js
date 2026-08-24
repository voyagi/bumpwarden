'use strict';

const path = require('path');
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { readNotes, findNote } = require('./lib/notes');

const app = express();
const port = process.env.PORT || 3000;

app.use(morgan('tiny'));
app.use(bodyParser.json({ limit: '64kb' }));
app.use(cookieParser());

app.get('/', (req, res) => {
  const notes = readNotes();
  res.json({ count: notes.length, notes: notes.map((note) => note.slug) });
});

app.get('/notes/:slug', (req, res) => {
  const note = findNote(req.params.slug);
  if (!note) return res.status(404).json({ error: 'no note with that name' });

  res.cookie('last-note', note.slug, { httpOnly: true, sameSite: 'lax' });
  res.type('text/markdown').send(note.body);
});

// express 4 spells this method in lower case. express 5 removed it along with `app.del`, so both
// call sites below are load-bearing for the upgrade.
app.get('/logo', (req, res) => {
  res.sendfile(path.join(__dirname, 'public', 'logo.svg'));
});

app.del('/notes/:slug/cookie', (req, res) => {
  res.clearCookie('last-note');
  res.status(204).end();
});

app.post('/webhook', (req, res) => {
  if (!req.body || !req.body.tag) return res.status(400).json({ error: 'tag is required' });
  res.status(202).json({ accepted: req.body.tag });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log('release notes board on http://127.0.0.1:' + port);
  });
}

module.exports = app;
