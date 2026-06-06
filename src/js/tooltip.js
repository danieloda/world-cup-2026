// ============================================================
// Tooltip flutuante compartilhado (delegação no document → sobrevive a
// re-renders). Dois modos:
//   • rico  — gatilho [data-tip] (sem valor) com um <template class="tip-src">
//             irmão carregando o HTML (usado no Histórico).
//   • texto — gatilho [data-tip="texto"] (usa o próprio atributo; usado p/
//             explicar termos de pontuação no Ranking).
// Hover (desktop), foco (teclado/a11y) e toque (mobile). Some ao rolar.
// ============================================================
export function initTooltips() {
  let tipEl = null;
  let current = null;

  const ensure = () => {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'hist-tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  };

  function show(trigger) {
    const txt = trigger.getAttribute('data-tip');
    const src = trigger.nextElementSibling;
    const el = ensure();
    if (txt) {
      el.classList.add('text-mode');
      el.textContent = txt;
    } else if (src && src.classList.contains('tip-src')) {
      el.classList.remove('text-mode');
      el.innerHTML = src.innerHTML;
    } else {
      return;
    }
    el.classList.add('show');
    current = trigger;
    position(trigger, el);
  }

  function hide() {
    if (tipEl) tipEl.classList.remove('show');
    current = null;
  }

  function position(trigger, el) {
    el.style.left = '-9999px';
    el.style.top = '0';
    const r = trigger.getBoundingClientRect();
    const tw = el.offsetWidth, th = el.offsetHeight;
    const gap = 9, pad = 8;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    let top = r.top - th - gap;
    let place = 'top';
    if (top < pad) { top = r.bottom + gap; place = 'bottom'; }
    el.dataset.place = place;
    const ax = Math.max(14, Math.min(r.left + r.width / 2 - left, tw - 14));
    el.style.setProperty('--tip-arrow', `${ax}px`);
    el.style.left = `${Math.round(left + window.scrollX)}px`;
    el.style.top = `${Math.round(top + window.scrollY)}px`;
  }

  // Desktop: hover
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) hide();
  });
  // Teclado/a11y: foco mostra, blur esconde
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('focusout', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) hide();
  });
  // Mobile: toque alterna; tocar fora fecha
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) { (current === t) ? hide() : show(t); }
    else if (current) hide();
  });
  // Some ao rolar (inclui scroll de containers internos)
  document.addEventListener('scroll', hide, { passive: true, capture: true });
}
