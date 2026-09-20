/**
 * Sign-up page: creates a real account on the console this page can reach.
 * Resolution mirrors login.js — a configured console origin, or this same
 * origin when the console is co-hosted (`vital serve --site`). The form posts
 * to the console's /api/signup route, which persists the account and grants
 * the signup credits; if no console answers, the page says so instead of
 * pretending an account exists.
 */
(function initSignupFlow() {
  const status = document.getElementById('console-target');
  const form = document.getElementById('signup-form');
  const alert = document.getElementById('signup-alert');
  const submit = document.getElementById('signup-submit');
  const success = document.getElementById('signup-success');
  if (!status || !form || !alert || !success) return;

  const fields = {
    firstName: document.getElementById('first-name'),
    lastName: document.getElementById('last-name'),
    email: document.getElementById('email'),
    password: document.getElementById('password'),
    consent: document.getElementById('consent'),
  };

  const configured = (document.querySelector('meta[name="vital-console-url"]')?.content || '')
    .trim()
    .replace(/\/$/, '');
  let consoleBase = configured && configured !== '.' && configured !== '/' ? configured : '';

  const paint = (cls, text) => {
    status.textContent = '● ' + text;
    status.className = 'console-target ' + cls;
  };

  const fail = (field, message) => {
    alert.textContent = '● ' + message;
    alert.className = 'signup-alert';
    alert.hidden = false;
    if (field) {
      field.classList.add('invalid');
      field.focus({ preventScroll: false });
    }
  };

  Object.values(fields).forEach((field) => {
    if (!field) return;
    field.addEventListener('input', () => {
      field.classList.remove('invalid');
      alert.hidden = true;
    });
  });

  // Password visibility + strength meter.
  const eye = document.getElementById('eye-btn');
  const open = document.getElementById('eye-open');
  const closed = document.getElementById('eye-closed');
  const meter = document.getElementById('pass-meter');
  const hint = document.getElementById('pass-hint');
  const DEFAULT_HINT = hint ? hint.textContent : '';
  const LABELS = ['', 'weak', 'fair', 'good', 'strong'];
  if (fields.password && eye && meter && hint) {
    eye.addEventListener('click', () => {
      const shown = fields.password.type === 'text';
      fields.password.type = shown ? 'password' : 'text';
      open.hidden = !shown;
      closed.hidden = shown;
      eye.setAttribute('aria-pressed', String(!shown));
      eye.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      fields.password.focus({ preventScroll: true });
    });
    fields.password.addEventListener('input', () => {
      const value = fields.password.value;
      let score = 0;
      if (value.length >= 12) score += 1;
      if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
      if (/\d/.test(value)) score += 1;
      if (/[^A-Za-z0-9]/.test(value)) score += 1;
      [...meter.children].forEach((bar, i) => {
        bar.className = i < score ? 'on ' + (score <= 1 ? 'weak' : score === 2 ? 'fair' : '') : '';
      });
      hint.textContent = value ? 'password strength · ' + LABELS[score] : DEFAULT_HINT;
    });
  }

  // Resolve the console and pick up the pre-session CSRF token + credit offer.
  let csrf = '';
  const offer = (base) => {
    return fetch(base + '/api/signup', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => {
        if (!j || !j.ok || !j.csrf) return Promise.reject('no token');
        csrf = j.csrf;
        const credits = Number(j.freeCredits) || 0;
        const creditsEl = document.getElementById('free-credits');
        if (creditsEl && credits > 0) creditsEl.textContent = String(credits);
        paint('live', 'console reachable · ' + (credits > 0 ? credits + ' free credits on signup' : 'signup open'));
        submit.disabled = false;
      });
  };

  const unreachable = () => {
    paint('down', 'no console is bound to this site — sign-up cannot run here');
    submit.disabled = true;
  };

  if (consoleBase) {
    offer(consoleBase).catch(() => {
      csrf = '';
      paint('down', 'configured console is not answering /api/signup');
      submit.disabled = true;
    });
  } else {
    fetch('/api/health', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => {
        if (!j || !j.engine) return Promise.reject('no engine');
        consoleBase = '';
        return offer('');
      })
      .catch(unreachable);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = (fields.email.value || '').trim();
    if (!fields.firstName.value.trim()) return fail(fields.firstName, 'first name is required');
    if (!fields.lastName.value.trim()) return fail(fields.lastName, 'last name is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(fields.email, 'enter a valid work email');
    if (fields.password.value.length < 12) return fail(fields.password, 'password needs 12+ characters');
    if (!fields.consent.checked) return fail(fields.consent, 'accept the terms & conditions to continue');
    if (!csrf) return fail(null, 'no console is reachable — sign-up cannot complete right now');

    submit.disabled = true;
    alert.hidden = true;
    fetch(consoleBase + '/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vital-csrf': csrf },
      credentials: 'same-origin',
      body: JSON.stringify({
        csrf,
        firstName: fields.firstName.value.trim(),
        lastName: fields.lastName.value.trim(),
        email,
        password: fields.password.value,
      }),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok || !j || !j.ok) throw new Error((j && j.error) || 'the console refused the request');
        const credits = String(j.credits || 0);
        const emailEl = document.getElementById('success-email');
        if (emailEl) emailEl.textContent = j.email || email;
        ['success-credits', 'success-credits-2'].forEach((id) => {
          const el = document.getElementById(id);
          if (el && credits !== '0') el.textContent = credits;
        });
        const signin = document.getElementById('success-signin');
        if (signin) signin.href = (consoleBase || '') + '/login';
        form.hidden = true;
        status.hidden = true;
        document.querySelector('.utility-card > .signin-note').hidden = true;
        success.hidden = false;
        const title = document.getElementById('success-title');
        if (title) title.focus();
      })
      .catch((e) => {
        submit.disabled = false;
        fail(null, e.message || 'account creation failed');
      });
  });
})();
