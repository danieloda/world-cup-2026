import { supabase } from '../supabase.js';
import { updatePassword } from '../auth.js';

const form = document.getElementById('resetForm');
const fields = document.getElementById('fields');
const statusBox = document.getElementById('statusBox');
const invalidBox = document.getElementById('invalidBox');
const againRow = document.getElementById('againRow');
const pw1 = document.getElementById('password');
const pw2 = document.getElementById('password2');
const submitBtn = document.getElementById('submitBtn');
const errorBox = document.getElementById('errorBox');
const successBox = document.getElementById('successBox');

// Mostrar/ocultar senha (mesma mecânica do login/signup), nos dois campos.
wirePwToggle('pwToggle', pw1);
wirePwToggle('pwToggle2', pw2);

function wirePwToggle(toggleId, input) {
  const btn = document.getElementById(toggleId);
  btn?.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('is-on', show);
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    input.focus();
  });
}

// ── Validação do link de recuperação ──────────────────────────────────────
// O link do email traz o token no hash; detectSessionInUrl (supabase.js)
// processa e dispara PASSWORD_RECOVERY, criando uma sessão temporária.
// Cobrimos 3 frentes: erro explícito no hash, o evento, e a checagem direta
// da sessão com um fallback por timeout (caso o evento já tenha passado).
let settled = false;

function showFields() {
  if (settled) return;
  settled = true;
  statusBox.hidden = true;
  invalidBox.hidden = true;
  againRow.hidden = true;
  fields.hidden = false;
  pw1.focus();
}

function showInvalid(msg) {
  if (settled) return;
  settled = true;
  statusBox.hidden = true;
  fields.hidden = true;
  invalidBox.textContent = msg || 'Link inválido ou expirado. Solicite um novo email de redefinição.';
  invalidBox.hidden = false;
  againRow.hidden = false;
}

// 1) Erro explícito no hash (link expirado/já usado) — lido de forma síncrona,
//    antes que o client limpe a URL.
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
if (hashParams.get('error')) {
  const code = (hashParams.get('error_code') || '').toLowerCase();
  const desc = (hashParams.get('error_description') || '').toLowerCase();
  const expired = code.includes('expired') || code.includes('otp') || desc.includes('expired');
  showInvalid(expired
    ? 'Esse link expirou ou já foi usado. Solicite um novo email de redefinição.'
    : 'Link inválido. Solicite um novo email de redefinição.');
}

// 2) Evento de recuperação disparado ao processar o hash.
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') showFields();
  else if (event === 'SIGNED_IN' && session) showFields();
});

// 3) Checagem direta da sessão + fallback (evento pode ter passado antes do
//    listener, ou a sessão pode demorar um tick pra materializar).
if (!settled) {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    showFields();
  } else {
    setTimeout(async () => {
      if (settled) return;
      const { data: { session: s2 } } = await supabase.auth.getSession();
      if (s2) showFields();
      else showInvalid('Link inválido ou expirado — ou você abriu esta página sem o link do email. Solicite um novo.');
    }, 2500);
  }
}

// ── Submit: grava a nova senha ─────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (fields.hidden) return; // link ainda não validado ou inválido
  hideMsgs();

  const p1 = pw1.value;
  const p2 = pw2.value;
  if (p1.length < 6) { showError('A senha precisa ter no mínimo 6 caracteres.'); return; }
  if (p1 !== p2) { showError('As senhas não coincidem.'); pw2.focus(); return; }

  setLoading(true);
  const result = await updatePassword(p1);
  if (!result.ok) {
    showError(result.error);
    setLoading(false);
    return;
  }

  // Sucesso — desloga a sessão de recuperação e manda pro login com a nova senha.
  showSuccess('Senha redefinida com sucesso! Redirecionando pro login…');
  await supabase.auth.signOut();
  setTimeout(() => window.location.replace('login.html?reset=1'), 1200);
});

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.textContent = loading ? 'Salvando…' : 'Salvar nova senha';
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
