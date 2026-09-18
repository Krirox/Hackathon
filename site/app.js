(function initNavigation() {
  const menu = document.getElementById('overlay');
  const trigger = document.getElementById('menu-btn');
  const close = document.getElementById('overlay-close');
  if (!menu || !trigger || !close || typeof menu.showModal !== 'function') return;

  trigger.addEventListener('click', () => {
    menu.showModal();
    trigger.setAttribute('aria-expanded', 'true');
    document.body.classList.add('menu-open');
    close.focus();
  });
  menu.addEventListener('close', () => {
    trigger.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-open');
  });
  function closeMenu() {
    menu.close();
    trigger.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-open');
    trigger.focus();
  }
  close.addEventListener('click', closeMenu);
  menu.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeMenu();
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...menu.querySelectorAll('button, a[href]')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  menu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      closeMenu();
      if (link.hash && link.origin === window.location.origin) {
        const destination = document.getElementById(link.hash.slice(1));
        if (destination) {
          destination.setAttribute('tabindex', '-1');
          destination.focus({ preventScroll: true });
        }
      }
    });
  });
  trigger.hidden = false;
})();

(function initLayers() {
  const tag = document.getElementById('card-tag');
  const description = document.getElementById('card-description');
  const layers = {
    1: ['The Reality Ledger', 'Append-only ground truth. No model may mint a FACT.'],
    2: ['Cognitive Router', 'REFLEX → WORKFLOW → MODEL → HUMAN with escalation caps.'],
    3: ['Coordination Surface', 'Typed QUERY / REQUEST / NOTICE over signed talk bindings.']
  };
  if (!tag || !description) return;
  const buttons = [...document.querySelectorAll('.layer-tab')];
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const data = layers[button.dataset.layer];
      if (!data) return;
      tag.textContent = data[0];
      description.textContent = data[1];
      buttons.forEach((item) => {
        const selected = item === button;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
    });
    button.disabled = false;
  });
  const prompt = document.querySelector('.interactive-prompt');
  if (prompt) prompt.hidden = false;
})();

(function initConsoleWiring() {
  const configured = (document.querySelector('meta[name="vital-console-url"]')?.content || '').trim().replace(/\/$/, '');
  // Empty meta = same-origin console routes when co-hosted via `vital serve --site`.
  const consoleBase = configured && configured !== '.' && configured !== '/' ? configured : '';
  const consolePath = (p) => (consoleBase ? `${consoleBase}${p}` : p);
  const externalConsole =
    consoleBase &&
    (() => {
      try {
        return new URL(consoleBase).origin !== window.location.origin;
      } catch {
        return true;
      }
    })();

  document.querySelectorAll('[data-console]').forEach((a) => {
    a.href = consolePath(a.dataset.consolePath || '/');
    if (externalConsole) {
      a.target = '_blank';
      a.rel = 'noopener';
      const label = a.getAttribute('aria-label') || a.textContent?.trim();
      if (label && !a.title) a.title = `Opens the Vital console in a new tab (${consoleBase})`;
    } else {
      a.removeAttribute('target');
      a.removeAttribute('rel');
    }
  });

  const status = document.getElementById('console-status');
  if (status && consoleBase) {
    const paint = (cls, text, title) => {
      status.textContent = '● ' + text;
      status.className = cls;
      if (title) status.title = title;
      else status.removeAttribute('title');
    };
    paint('unknown', 'console status unknown');
    fetch(consoleBase + '/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(
        (j) =>
          paint(
            'live',
            `console reachable · ${j.engine} · ${new Date(j.at).toLocaleTimeString()}`,
            'Reachability only — the process answered. Ingestion, execution, and measurement readiness are reported inside the console.',
          ),
        () => paint('down', 'console not reachable')
      );
  }
})();
