'use strict';

const fetch = require('node-fetch');

const CHANGELOG = 'https://api.github.com/repos/nodejs/node/releases/latest';

// node-fetch 2 takes `timeout` and `size` as options. Both were dropped in 3, where the timeout
// moves to an AbortSignal, so a bump here is not a drop-in replacement.
function latestNodeRelease() {
  return fetch(CHANGELOG, {
    timeout: 5000,
    size: 512 * 1024,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'bumpwarden-demo-app' },
  })
    .then((response) => {
      if (!response.ok) throw new Error('upstream answered ' + response.status);
      return response.json();
    })
    .then((body) => ({ tag: body.tag_name, published: body.published_at }));
}

module.exports = { latestNodeRelease: latestNodeRelease };
