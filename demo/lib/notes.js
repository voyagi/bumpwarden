'use strict';

const fs = require('fs');
const path = require('path');
const glob = require('glob');

const NOTES_DIR = path.join(__dirname, '..', 'notes');

// `root` is glob 7's mount point for a pattern that starts with a slash, so the leading slash is
// what makes this read the notes directory rather than wherever the process happened to start.
// Newer majors dropped the option entirely, so this is one of the calls to check first.
function noteFiles() {
  const paths = glob.sync('/*.md', { root: NOTES_DIR, nodir: true });
  return paths.sort();
}

function titleOf(text, fallback) {
  const heading = text.split('\n').find((line) => line.startsWith('# '));
  return heading ? heading.slice(2).trim() : fallback;
}

function readNotes() {
  return noteFiles().map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const slug = path.basename(file, '.md');
    return { slug: slug, title: titleOf(text, slug), body: text };
  });
}

function findNote(slug) {
  return readNotes().find((note) => note.slug === slug) || null;
}

module.exports = { readNotes: readNotes, findNote: findNote, noteFiles: noteFiles };
