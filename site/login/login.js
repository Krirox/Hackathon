/**
 * The public site holds no sessions. This page resolves where the console
 * actually lives — a configured origin, the same origin when co-hosted, or
 * nowhere — and says so plainly instead of dead-ending on a 404.
 */
(function resolveConsole() {
  const status = document.getElementById('console-target');
  const button = document.getElementById('console-continue');
  if (!status || !button) return;

  const configured = (document.querySelector('meta[name="vital-console-url"]')?.content || '')
    .trim()
    .replace(/\/$/, '');
  const consoleBase = configured && configured !== '.' && configured !== '/' ? configured : '';

  const paint = (cls, text) => {
    status.textContent = '● ' + text;
    status.className = 'console-target ' + cls;
  };

  const offer = (href) => {
    button.href = href;
    button.hidden = false;
  };

  if (consoleBase) {
    paint('live', 'console configured · ' + consoleBase);
    offer(consoleBase + '/login');
    return;
  }

  // No configured origin: the console is either co-hosted here or absent.
  fetch('/api/health')
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((j) => {
      if (!j || !j.engine) return Promise.reject('no engine');
      paint('live', 'console reachable on this origin · ' + j.engine);
      offer('/login');
    })
    .catch(() => {
      paint('down', 'no console is bound to this site');
      button.hidden = true;
    });
})();
