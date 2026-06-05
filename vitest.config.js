import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/unit/**/*.test.js'],
    // TZ de produção (usuários no Brasil). Trava o relógio dos testes em BRT
    // para que dev (macOS) e CI (Ubuntu/UTC) rodem IDÊNTICOS — bug de data não
    // pode depender da TZ da máquina. Node relê process.env.TZ a cada Date.
    env: { TZ: 'America/Sao_Paulo' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Só o núcleo de lógica PURA é medido por unit. Page-scripts (DOM +
      // Supabase) são cobertos por E2E, não aqui — incluí-los aqui só diluiria
      // a métrica e daria falsa sensação de cobertura.
      include: [
        'src/js/scoring.js',
        'src/js/thirds-assign.js',
        'src/js/util.js',
      ],
      // Thresholds per-file = catraca anti-regressão. Falha o build se a
      // cobertura cair abaixo do piso atual. Sobem conforme adicionamos testes;
      // NUNCA descem sem justificativa. (medido em 2026-06-05)
      thresholds: {
        'src/js/scoring.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/js/thirds-assign.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/js/util.js': { statements: 55, branches: 92, functions: 50, lines: 55 },
      },
    },
  },
});
