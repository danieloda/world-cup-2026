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
 * Cadastro: email + senha + nome de exibição.
 * O nome vai pro user_metadata (full_name) e é usado quando o profile
 * é auto-criado no primeiro login (após confirmar email).
 * Com "Confirm email" ON no Supabase, NÃO há sessão até confirmar.
 * Retorna { ok, error, needsConfirmation }.
 */
export async function signUp(email, password, fullName) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${window.location.origin}/login.html?confirmed=1`,
    },
  });
  if (error) return { ok: false, error: humanizeAuthError(error) };
  // Se identities vazio = email já cadastrado (Supabase não revela por segurança)
  const alreadyExists = data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0;
  if (alreadyExists) {
    return { ok: false, error: 'Este email já está cadastrado. Tente entrar.' };
  }
  // session null = precisa confirmar email
  return { ok: true, needsConfirmation: !data.session };
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
 * Auto-cria profile no primeiro login (com defaults seguros).
 * Use no início de cada página protegida.
 *
 * Gate de avatar: se o profile não tem avatar_url, redireciona pra
 * complete-profile.html (avatar é obrigatório). Pule esse gate passando
 * { skipAvatarGate: true } na própria complete-profile.html.
 *
 * Opções:
 *   { adminOnly: true }       — exige is_admin no profile
 *   { skipAvatarGate: true }  — não redireciona mesmo sem avatar
 */
export async function requireAuth(options = {}) {
  const session = await getSession();
  if (!session) {
    window.location.replace('login.html');
    return null;
  }
  let profile = await getProfile();
  if (!profile) {
    // Primeiro login — auto-criar profile com defaults seguros.
    profile = await createMyProfile(session.user);
    if (!profile) {
      console.error('Falha ao criar profile auto.');
      await supabase.auth.signOut();
      window.location.replace('login.html?error=profile');
      return null;
    }
  }
  if (options.adminOnly && !profile.is_admin) {
    window.location.replace('inicio.html');
    return null;
  }
  // Gate de avatar obrigatório (admins isentos — já têm avatar local)
  if (!options.skipAvatarGate && !profile.avatar_url && !profile.is_admin) {
    window.location.replace('complete-profile.html');
    return null;
  }
  return { session, profile };
}

async function createMyProfile(user) {
  const name = user.user_metadata?.full_name
            || user.user_metadata?.name
            || user.email.split('@')[0];
  const { data, error } = await supabase
    .from('profiles')
    .insert({
      id: user.id,
      full_name: name,
      email: user.email,
      is_admin: false,
      paid: false,
    })
    .select()
    .single();
  if (error) {
    console.error('createMyProfile:', error);
    return null;
  }
  return data;
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
  if (msg.includes('email not confirmed')) return 'Confirme seu email antes de entrar. Veja sua caixa de entrada.';
  if (msg.includes('rate limit') || msg.includes('too many')) return 'Muitas tentativas. Espere alguns minutos.';
  if (msg.includes('already registered') || msg.includes('already been registered')) return 'Este email já está cadastrado. Tente entrar.';
  if (msg.includes('password') && msg.includes('least')) return 'A senha precisa ter no mínimo 6 caracteres.';
  if (msg.includes('weak password') || msg.includes('password is too')) return 'Senha muito fraca. Use ao menos 6 caracteres.';
  if (msg.includes('unable to validate email') || msg.includes('invalid format') || msg.includes('email address') && msg.includes('invalid')) return 'Email inválido.';
  if (msg.includes('network') || msg.includes('failed to fetch')) return 'Sem conexão. Verifique sua internet.';
  return error.message || 'Erro. Tente novamente.';
}
