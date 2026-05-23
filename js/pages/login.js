import { signIn, redirectIfAuthed } from '../auth.js';

// Se já tem sessão, vai direto pra Início.
redirectIfAuthed();

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitBtn = document.getElementById('submitBtn');
const errorBox = document.getElementById('errorBox');

// Mostra erro vindo de redirect (?error=profile)
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('error') === 'profile') {
  showError('Sua conta existe, mas o perfil não foi configurado. Contate o admin.');
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
}

function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}
