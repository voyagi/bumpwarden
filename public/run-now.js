// Progressive enhancement for the Run now button. Without this file the form still works: the
// browser posts it and the request simply holds open until the run finishes. With it, the post is
// made in the background and the page asks the status endpoint how the run is going, which is the
// only way to show progress without a websocket the free tier would not thank us for.

const POLL_MS = 3000;

function setup(form) {
  const repositoryId = form.dataset.runNow;
  const button = form.querySelector('button');
  const status = form.querySelector('[data-run-status]');
  if (!repositoryId || !button || !status) return;

  const statusUrl = `/projects/${encodeURIComponent(repositoryId)}/run-status`;
  let polling = null;

  function show(state) {
    status.textContent =
      state.state === 'running'
        ? `${state.message} ${state.elapsedSeconds}s elapsed.`
        : state.message;
    button.disabled = state.state !== 'ready';
  }

  async function poll() {
    let state;
    try {
      const response = await fetch(statusUrl, { headers: { accept: 'application/json' } });
      state = await response.json();
    } catch {
      // A dropped poll is not a failed run. The next tick asks again, and the run itself is
      // finished or not regardless of whether this page could reach the endpoint.
      return;
    }

    show(state);
    if (state.state !== 'running') {
      window.clearInterval(polling);
      polling = null;
      // The queue, the spread and the audit log all changed, so the honest refresh is the page.
      window.location.reload();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (button.disabled) return;

    button.disabled = true;
    status.textContent = 'Starting the run.';
    if (!polling) polling = window.setInterval(poll, POLL_MS);

    fetch(form.action, { method: 'POST', headers: { accept: 'application/json' } })
      .then(() => poll())
      .catch(() => {
        status.textContent = 'The run could not be started. Reload the page and try again.';
        button.disabled = false;
      });
  });

  // A run already in flight when the page loaded, started by the scheduler or by another visitor,
  // is still worth watching.
  if (button.disabled && status.textContent.indexOf('Running') === 0) {
    polling = window.setInterval(poll, POLL_MS);
  }
}

for (const form of document.querySelectorAll('[data-run-now]')) {
  setup(form);
}
