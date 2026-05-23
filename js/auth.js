// Auth helpers: sessão, login, logout, route guard, profile.

import { supabase } from './supabase.js';

/**
 * Retorna a sessão atual (ou null).
 */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.warn('getSession error:', error);
    return null;
  }
  return data.session;
}

/**
 * Retorna o usuário autenticado (ou null).
 */
export async function getUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Busca o perfil estendido da tabela `profiles`.
 * Retorna null se não autenticado ou perfil não existir.
 */
export async function getProfile() {
  const user = await getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    console.warn('getProfile error:', error);
    return null;
  }
  return data;
}

/**
 * Login via email/senha. Retorna { ok, error }.
 */
export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: humanizeAuthError(error) };
  return { ok: true };
}

/**
 * Logout e redireciona pra /login.
 */
export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = 'login.html';
}

/**
 * Route guard: redireciona pra login se não autenticado.
 * Use no início de cada página protegida.
 *
 * Opções:
 *   { adminOnly: true }  — exige is_admin no profile
 */
export async function requireAuth(options = {}) {
  const session = await getSession();
  if (!session) {
    window.location.replace('login.html');
    return null;
  }
  const profile = await getProfile();
  if (!profile) {
    // Usuário autenticado mas sem profile (estado inválido). Loga e força login.
    console.error('Usuário autenticado mas sem profile. Verifique tabela profiles.');
    await supabase.auth.signOut();
    window.location.replace('login.html?error=profile');
    return null;
  }
  if (options.adminOnly && !profile.is_admin) {
    window.location.replace('inicio.html');
    return null;
  }
  return { session, profile };
}

/**
 * Inverso: se já autenticado, redireciona pra Início.
 * Use na página de login.
 */
export async function redirectIfAuthed() {
  const session = await getSession();
  if (session) {
    window.location.replace('inicio.html');
  }
}

/**
 * Traduz mensagens de erro do Supabase pro PT-BR.
 */
function humanizeAuthError(error) {
  const msg = (error.message || '').toLowerCase();
  if (msg.includes('invalid login credentials')) return 'Email ou senha incorretos.';
  if (msg.includes('email not confirmed')) return 'Confirme seu email antes de entrar.';
  if (msg.includes('rate limit')) return 'Muitas tentativas. Espere alguns minutos.';
  if (msg.includes('network')) return 'Sem conexão. Verifique sua internet.';
  return error.message || 'Erro ao fazer login. Tente novamente.';
}
