// Stub temporário para páginas ainda não implementadas.
// Cada página vazia (grupos.html, ranking.html, etc.) usa este script com data-active.

import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';

const auth = await requireAuth();
if (!auth) throw new Error('not authed');

const { profile } = auth;
const { data: stats } = await supabase.from('v_pool_stats').select('*').single();

// Lê metadados da página via <body data-active="..." data-title="...">.
const body = document.body;
const active = body.dataset.active || '';
const title = body.dataset.title || 'Em breve';

const pageBody = await renderShell({ active, profile, stats });
pageBody.innerHTML = `
  <section class="hero">
    <div class="hero-kicker">Em construção</div>
    <h1 class="hero-title">${title}</h1>
    <div class="hero-meta">Esta tela ainda não foi implementada.</div>
  </section>
  <div class="empty">
    <h3>🚧 Próximo no roadmap</h3>
    <p>Volte ao <strong>Início</strong> enquanto finalizamos essa página.</p>
    <a class="btn btn-green" href="inicio.html">Voltar ao Início</a>
  </div>
`;
