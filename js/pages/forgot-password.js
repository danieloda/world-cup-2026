import { requestPasswordReset, redirectIfAuthed } from '../auth.js';

// Se já tem sessão, não faz sentido estar aqui.
redirectIfAuthed();

const form = document.getElementById('forgotForm');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submitBtn');
const errorBox = document.getElementById('errorBox');
const successBox = document.getElementById('successBox');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMsgs();

  const email = emailInput.value.trim();
  if (!email) return;

  setLoading(true);
  const result = await requestPasswordReset(email);
  setLoading(false);

  if (!result.ok) {
    showError(result.error);
    return;
  }

  // Mensagem genérica de propósito: não revelamos se o email existe.
  form.querySelectorAll('input, button[type="submit"]').forEach((el) => { el.disabled = true; });
  showSuccess(`Se houver uma conta com ${email}, enviamos um link pra redefinir a senha. Olhe sua caixa de entrada (e o spam). O link vale por 1 hora.`);
});

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.textContent = loading ? 'Enviando…' : 'Enviar link';
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
