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
