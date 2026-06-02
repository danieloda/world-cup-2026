// Inicializa o cliente Supabase.
// Importa a config local (gitignored) e exporta o client compartilhado.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import { APP_CONFIG } from './config.js';

if (!APP_CONFIG.SUPABASE_URL || !APP_CONFIG.SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('config.js não está preenchido. Copie config.example.js e configure.');
}

export const supabase = createClient(
  APP_CONFIG.SUPABASE_URL,
  APP_CONFIG.SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

// Pagina uma query além do teto padrão de 1000 linhas do PostgREST.
// Recebe uma FUNÇÃO que constrói a query (com seus filtros), aplica .range()
// por página e concatena tudo. Use em qualquer leitura cujo volume cresça com
// (usuários × jogos) — ex.: todos os palpites do bolão — senão o cliente recebe
// só as primeiras 1000 linhas SILENCIOSAMENTE e os totais saem errados.
// IMPORTANTE: a query precisa de um .order() estável (ex.: 'id') pra paginação
// não duplicar/pular linhas entre páginas.
export async function fetchAllPages(makeQuery, pageSize = 1000) {
  const all = [];
  for (let page = 0; ; page++) {
    const from = page * pageSize;
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    if (data?.length) all.push(...data);
    if (!data || data.length < pageSize) break;
  }
  return all;
}
