// Tracker centralizado de TODOS os erros durante o E2E.
// Captura: UI errors (pageerror, console.error, request failures), API errors (supabase), DB errors (alert_log).

import { writeFileSync, readFileSync, existsSync } from 'fs';

export class ErrorTracker {
  constructor(outputPath) {
    this.outputPath = outputPath;
    this.errors = [];
    this.startedAt = new Date().toISOString();
    this.context = {};  // current context (user, step, etc.)
  }

  setContext(ctx) {
    this.context = { ...this.context, ...ctx };
  }

  clearContext(keys) {
    for (const k of keys) delete this.context[k];
  }

  /**
   * Registra erro.
   * @param category 'ui_pageerror' | 'ui_console' | 'ui_request_failed' | 'api_supabase' | 'db_alert' | 'assertion' | 'unknown'
   */
  track(category, message, extra = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      category,
      message: String(message),
      context: { ...this.context },
      ...extra,
    };
    this.errors.push(entry);
    return entry;
  }

  /**
   * Conecta nos eventos do Playwright Page pra capturar erros automaticamente.
   */
  attachPlaywright(page) {
    page.on('pageerror', (err) => {
      this.track('ui_pageerror', err.message, { stack: err.stack });
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        const pageUrl = page.url();
        // Ignora erros conhecidos/ruidosos
        if (text.includes('favicon.ico') || text.includes('manifest.json')) return;
        // 404 quando a page url eh um path .html sem extensão = false positive do serve rewrite
        if (text.includes('404') &&
            /\/(login|inicio|grupos|ranking|admin|palpites-grupos|palpites-mata|campeao-artilheiro|historico|terceiros)(\b|$)/.test(pageUrl) &&
            !pageUrl.endsWith('.html')) return;
        this.track('ui_console', text, { url: pageUrl });
      }
    });

    page.on('requestfailed', (req) => {
      this.track('ui_request_failed', `${req.method()} ${req.url()}: ${req.failure()?.errorText}`, {
        url: req.url(),
        method: req.method(),
      });
    });

    page.on('response', async (res) => {
      const status = res.status();
      if (status >= 400 && status < 600) {
        const url = res.url();
        // Ignora 404 de favicon/etc
        if (url.includes('favicon') || url.includes('.map')) return;
        let body = '';
        try { body = (await res.text()).slice(0, 500); } catch {}
        this.track('ui_response_error', `${status} ${res.request().method()} ${url}`, {
          status, url, body,
        });
      }
    });
  }

  /**
   * Conecta numa instancia supabase pra capturar API errors.
   * Como supabase-js nao tem hook global de erros, retornamos um wrapper.
   */
  wrapSupabase(client) {
    const tracker = this;
    return new Proxy(client, {
      get(target, prop) {
        const orig = target[prop];
        if (typeof orig !== 'function') return orig;
        return function (...args) {
          const result = orig.apply(target, args);
          // Se eh uma promise, intercepta erros
          if (result && typeof result.then === 'function') {
            return result.then((r) => {
              if (r && r.error) {
                tracker.track('api_supabase', r.error.message, {
                  method: prop, code: r.error.code, hint: r.error.hint,
                });
              }
              return r;
            });
          }
          return result;
        };
      },
    });
  }

  /**
   * Le alert_log do DB e adiciona qualquer entry NOVA desde startedAt.
   */
  async pollDbAlerts(adminClient) {
    const { data, error } = await adminClient
      .from('alert_log')
      .select('*')
      .gte('created_at', this.startedAt)
      .order('created_at', { ascending: false });
    if (error) {
      this.track('unknown', 'failed to poll alert_log: ' + error.message);
      return;
    }
    for (const a of data) {
      if (a.severity === 'critical' || a.severity === 'warn') {
        // Vai cair como erro reportado
        this.track('db_alert', `[${a.severity}] ${a.category}: ${a.title}`, {
          alert_id: a.id, severity: a.severity, category: a.category,
          body: a.body, alert_context: a.context,
        });
      }
    }
  }

  summary() {
    const byCategory = {};
    const byContext = {};
    for (const e of this.errors) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      const ctxKey = e.context.user_key || e.context.step || 'global';
      byContext[ctxKey] = (byContext[ctxKey] ?? 0) + 1;
    }
    return { total: this.errors.length, byCategory, byContext };
  }

  flush() {
    writeFileSync(this.outputPath, JSON.stringify({
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      summary: this.summary(),
      errors: this.errors,
    }, null, 2));
  }

  print() {
    const sum = this.summary();
    console.log('');
    console.log('═══ ERROR TRACKER ═══');
    console.log(`   Total errors: ${sum.total}`);
    if (sum.total > 0) {
      console.log(`   Por categoria:`);
      for (const [cat, n] of Object.entries(sum.byCategory)) {
        console.log(`     ${cat.padEnd(25)} ${n}`);
      }
      console.log(`   Por contexto:`);
      for (const [ctx, n] of Object.entries(sum.byContext)) {
        console.log(`     ${ctx.padEnd(25)} ${n}`);
      }
    }
  }
}

export function loadErrors(outputPath) {
  if (!existsSync(outputPath)) return null;
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}
