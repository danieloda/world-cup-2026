import { signIn, redirectIfAuthed } from '../auth.js';

// Se já tem sessão, vai direto pra Início.
redirectIfAuthed();

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitBtn = document.getElementById('submitBtn');
const errorBox = document.getElementById('errorBox');
const successBox = document.getElementById('successBox');

// Mostrar/ocultar senha
const pwToggle = document.getElementById('pwToggle');
pwToggle?.addEventListener('click', () => {
  const show = passwordInput.type === 'password';
  passwordInput.type = show ? 'text' : 'password';
  pwToggle.classList.toggle('is-on', show);
  pwToggle.setAttribute('aria-pressed', String(show));
  pwToggle.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  passwordInput.focus();
});

// Mensagens vindas de redirect
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('error') === 'profile') {
  showError('Sua conta existe, mas o perfil não foi configurado. Contate o admin.');
}
if (urlParams.get('confirmed') === '1') {
  showSuccess('Email confirmado! Agora entre com seu email e senha.');
}
if (urlParams.get('reset') === '1') {
  showSuccess('Senha redefinida! Entre com sua nova senha.');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  setLoading(true);

  const result = await signIn(emailInput.value.trim(), passwordInput.value);

  if (!result.ok) {
    showError(result.error);
    setLoading(false);
    return;
  }

  window.location.href = 'inicio.html';
});

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.textContent = loading ? 'Entrando…' : 'Entrar';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
  if (successBox) successBox.hidden = true;
}

function showSuccess(msg) {
  if (!successBox) return;
  successBox.textContent = msg;
  successBox.hidden = false;
  errorBox.hidden = true;
}

function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}
