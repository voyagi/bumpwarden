'use strict';

const chalk = require('chalk');
const { readNotes } = require('./lib/notes');
const { latestNodeRelease } = require('./lib/upstream');

// chalk 4 still has the CSS colour helpers. `keyword` went away in 5 and the whole package moved to
// ESM there, so this file is the reason a chalk bump is not a one-line change.
const heading = chalk.keyword('orange').bold;
const dim = chalk.ansi256(245);

function print() {
  const notes = readNotes();
  console.log(heading('release notes on file: ' + notes.length));

  notes.forEach((note) => {
    console.log('  ' + note.title + dim('  (' + note.slug + ')'));
  });

  return latestNodeRelease()
    .then((release) => {
      console.log(heading('newest node release: ' + release.tag));
    })
    .catch((error) => {
      console.log(chalk.red('could not read the upstream changelog: ' + error.message));
    });
}

if (require.main === module) {
  print();
}

module.exports = { print: print };
