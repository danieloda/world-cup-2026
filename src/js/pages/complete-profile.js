import { requireAuth, signOut } from '../auth.js';
import { supabase } from '../supabase.js';
import { getInitials } from '../util.js';

// Gate de avatar — NÃO redireciona pra cá mesmo sem avatar (skipAvatarGate)
const auth = await requireAuth({ skipAvatarGate: true });
if (!auth) throw new Error('not authed');
const { profile } = auth;

// Se já tem avatar, não precisa estar aqui
if (profile.avatar_url) {
  window.location.replace('inicio.html');
}

const form = document.getElementById('profileForm');
const fileInput = document.getElementById('avatarFile');
// O <input type=file> é hidden; o <label> precisa ser operável por teclado.
const avatarLabel = document.getElementById('avatarLabel');
avatarLabel?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
const previewImg = document.getElementById('previewImg');
const previewInitials = document.getElementById('previewInitials');
const submitBtn = document.getElementById('submitBtn');
const errorBox = document.getElementById('errorBox');
const logoutLink = document.getElementById('logoutLink');

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];
let selectedFile = null;

// Mostra iniciais como placeholder
previewInitials.textContent = getInitials(profile.full_name || profile.email || '?');

logoutLink.addEventListener('click', (e) => {
  e.preventDefault();
  signOut();
});

fileInput.addEventListener('change', () => {
  hideError();
  const file = fileInput.files?.[0];
  if (!file) return;

  if (!ALLOWED.includes(file.type)) {
    showError('Formato inválido. Use PNG, JPG ou WEBP.');
    return;
  }
  if (file.size > MAX_BYTES) {
    showError('Imagem muito grande (máx 2MB).');
    return;
  }

  selectedFile = file;
  // Preview
  const reader = new FileReader();
  reader.onload = (ev) => {
    previewImg.src = ev.target.result;
    previewImg.hidden = false;
    previewInitials.hidden = true;
  };
  reader.readAsDataURL(file);
  submitBtn.disabled = false;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedFile) {
    showError('Escolha uma imagem primeiro.');
    return;
  }
  hideError();
  setLoading(true);

  try {
    const ext = selectedFile.type === 'image/png' ? 'png'
              : selectedFile.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `${profile.id}/avatar.${ext}`;

    // Upload pro Storage (upsert pra permitir retry/troca)
    const { error: upErr } = await supabase.storage
      .from('avatars')
      .upload(path, selectedFile, { upsert: true, contentType: selectedFile.type });
    if (upErr) throw new Error('Upload falhou: ' + upErr.message);

    // URL pública (cache-bust com timestamp pra forçar refresh)
    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
    const publicUrl = `${pub.publicUrl}?v=${Date.now()}`;

    // Salva no profile
    const { error: updErr } = await supabase
      .from('profiles')
      .update({ avatar_url: publicUrl })
      .eq('id', profile.id);
    if (updErr) throw new Error('Não foi possível salvar: ' + updErr.message);

    window.location.href = 'inicio.html';
  } catch (err) {
    showError(err.message || 'Erro ao salvar. Tente novamente.');
    setLoading(false);
  }
});

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.textContent = loading ? 'Salvando…' : 'Salvar e entrar';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.hidden = true;
}
