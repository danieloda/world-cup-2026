// ============================================================
// Ícones dos clusters de KPI (compartilhado entre Início, Palpites de grupos e
// mata-mata). stroke = currentColor → o .kpi-cap define a cor por variante.
// ============================================================
const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

export const KPI = {
  position: ic('<path d="M6 20v-6M12 20V8M18 20V4M3 20h18"/>'),                                   // ranking (barras)
  points:   ic('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/>'),                           // troféu (pontos)
  exact:    ic('<circle cx="12" cy="8" r="6"/><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5"/>'),    // medalha (exatos)
  cup:      ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),                          // relógio (progresso)
  done:     ic('<path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10"/><path d="M9 12l2.5 2.5L22 4"/>'), // check (palpitados)
  pending:  ic('<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>'),                 // alerta (faltando)
  total:    ic('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'),      // lista (total)
  partial:  ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>'),               // alvo (parciais)
  miss:     ic('<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>'),                  // x (erros)
  locked:   ic('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'), // cadeado (travados)
};
