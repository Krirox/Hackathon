/**
 * Sign-up page interactions: rotating brand statements on the visual panel,
 * password visibility and strength, inline validation, and a staged
 * provisioning success state. The public site holds no sessions and no
 * credentials — nothing in this file leaves the browser.
 */
(function initTaglineCarousel() {
  const tagline = document.getElementById('signup-tagline');
  const visual = document.querySelector('.signup-visual');
  const dots = [...document.querySelectorAll('.signup-dot')];
  if (!tagline || !visual || dots.length < 2) return;

  let index = 0;
  let hovering = false;
  let timer = null;

  const show = (next) => {
    if (next === index) return;
    index = next;
    tagline.classList.add('is-swapping');
    window.setTimeout(() => {
      tagline.textContent = dots[index]?.dataset.tagline || tagline.textContent;
      dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
        dot.setAttribute('aria-current', String(i === index));
      });
      tagline.classList.remove('is-swapping');
    }, 240);
  };

  dots.forEach((dot, i) => dot.addEventListener('click', () => show(i)));

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  visual.addEventListener('mouseenter', () => {
    hovering = true;
  });
  visual.addEventListener('mouseleave', () => {
    hovering = false;
  });
  visual.addEventListener('focusin', () => {
    hovering = true;
  });
  visual.addEventListener('focusout', () => {
    hovering = false;
  });
  timer = window.setInterval(() => {
    if (!hovering && !document.hidden) show((index + 1) % dots.length);
  }, 6500);
  window.addEventListener('pagehide', () => window.clearInterval(timer));
})();

(function initPasswordTools() {
  const input = document.getElementById('password');
  const eye = document.getElementById('eye-btn');
  const open = document.getElementById('eye-open');
  const closed = document.getElementById('eye-closed');
  const meter = document.getElementById('pass-meter');
  const hint = document.getElementById('pass-hint');
  if (!input || !eye || !meter || !hint) return;

  const DEFAULT_HINT = hint.textContent;
  const LABELS = ['', 'weak', 'fair', 'good', 'strong'];

  eye.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    open.hidden = !shown;
    closed.hidden = shown;
    eye.setAttribute('aria-pressed', String(!shown));
    eye.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
    input.focus({ preventScroll: true });
  });

  input.addEventListener('input', () => {
    const value = input.value;
    let score = 0;
    if (value.length >= 8) score += 1;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
    if (/\d/.test(value)) score += 1;
    if (/[^A-Za-z0-9]/.test(value)) score += 1;
    [...meter.children].forEach((bar, i) => {
      bar.className = i < score ? 'on ' + (score <= 1 ? 'weak' : score === 2 ? 'fair' : '') : '';
    });
    hint.textContent = value ? 'password strength · ' + LABELS[score] : DEFAULT_HINT;
  });
})();

(function initSubmitFlow() {
  const form = document.getElementById('signup-form');
  const alert = document.getElementById('signup-alert');
  const socialWrap = document.getElementById('signup-social-wrap');
  const success = document.getElementById('signup-success');
  const successEmail = document.getElementById('success-email');
  const successTitle = document.getElementById('success-title');
  const note = document.querySelector('.signup-panel > .signin-note');
  const switchLine = document.querySelector('.signup-switch');
  if (!form || !alert || !success) return;

  const fields = {
    firstName: document.getElementById('first-name'),
    lastName: document.getElementById('last-name'),
    email: document.getElementById('email'),
    password: document.getElementById('password'),
    consent: document.getElementById('consent'),
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

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = fields.email?.value.trim() || '';
    if (!fields.firstName?.value.trim()) return fail(fields.firstName, 'first name is required');
    if (!fields.lastName?.value.trim()) return fail(fields.lastName, 'last name is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(fields.email, 'enter a valid work email');
    if ((fields.password?.value || '').length < 8) return fail(fields.password, 'password needs 8+ characters');
    if (!fields.consent?.checked) return fail(fields.consent, 'accept the terms & conditions to continue');

    if (successEmail) successEmail.textContent = email;
    form.hidden = true;
    if (socialWrap) socialWrap.hidden = true;
    if (note) note.hidden = true;
    if (switchLine) switchLine.hidden = true;
    success.hidden = false;
    successTitle?.focus();
  });

  document.querySelectorAll('.social-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const provider = button.dataset.provider || 'This provider';
      alert.textContent =
        '● ' + provider.toLowerCase() + ' sign-up completes on your organization’s console — continue with email here.';
      alert.className = 'signup-alert info';
      alert.hidden = false;
    });
  });
})();
