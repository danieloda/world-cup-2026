import { signUp, redirectIfAuthed } from '../auth.js';

// Se já tem sessão, vai pra Início.
redirectIfAuthed();

const form = document.getElementById('signupForm');
const nameInput = document.getElementById('fullName');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitBtn = document.getElementById('submitBtn');
const errorBox = document.getElementById('errorBox');
const successBox = document.getElementById('successBox');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMsgs();

  const fullName = nameInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (fullName.length < 2) {
    showError('Digite seu nome de exibição (mínimo 2 caracteres).');
    return;
  }
  if (password.length < 6) {
    showError('A senha precisa ter no mínimo 6 caracteres.');
    return;
  }

  setLoading(true);
  const result = await signUp(email, password, fullName);
  setLoading(false);

  if (!result.ok) {
    showError(result.error);
    return;
  }

  if (result.needsConfirmation) {
    // Email confirmation ON — usuário precisa confirmar antes de entrar
    form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    showSuccess(`Conta criada! 📩 Enviamos um email de confirmação para ${email}. Clique no link, faça login e escolha sua foto de avatar pra começar.`);
  } else {
    // Sem email confirmation (caso desligado) — vai direto pro perfil
    window.location.href = 'complete-profile.html';
  }
});

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.textContent = loading ? 'Criando…' : 'Criar conta';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
  successBox.hidden = true;
}

function showSuccess(msg) {
  successBox.textContent = msg;
  successBox.hidden = false;
  errorBox.hidden = true;
}

function hideMsgs() {
  errorBox.hidden = true;
  successBox.hidden = true;
}
