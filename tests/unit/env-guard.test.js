import { describe, it, expect } from 'vitest';

/**
 * Guarda do ambiente de teste. Se algum dia a TZ não for aplicada (Node às
 * vezes cacheia a TZ no primeiro uso de Date), os testes de data passariam a
 * divergir silenciosamente entre dev (BRT) e CI (UTC). Aqui isso vira uma
 * falha explícita e imediata — não um bug de fuso mascarado.
 * Configurado em vitest.config.js → test.env.TZ.
 *
 * ⚠️ CUIDADO: este guard AFIRMA a variável (TZ) que quebra na vida real. Travar
 * a TZ deixa os outros testes de data determinísticos, mas sozinho dá falsa
 * confiança — um teste que só roda no fuso "certo" jamais pega bug de fuso.
 * A cobertura REAL de fuso vem de date-tz-invariance.test.js, que VARIA a TZ em
 * subprocessos. Os dois andam juntos: não remova um sem o outro.
 */
describe('ambiente de teste', () => {
  it('roda em America/Sao_Paulo (TZ de produção)', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Sao_Paulo');
  });

  it('offset é UTC-3 (BRT, sem horário de verão)', () => {
    // Junho: sem DST no Brasil desde 2019 → offset fixo de 180 min.
    expect(new Date('2026-06-15T12:00:00Z').getTimezoneOffset()).toBe(180);
  });
});
