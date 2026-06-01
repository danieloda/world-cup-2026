// supabase/functions/telegram-alert/index.ts
//
// Recebe alertas do DB e envia mensagens formatadas pro Telegram.
//
// Triggered por: pg_net.http_post() chamado nos triggers do migration 007_alerts.sql.
// Não-autenticado (verify_jwt=false em config.toml) porque vem do próprio DB.
//
// Failure mode: SEMPRE retorna 200 pra não travar o trigger SQL. Erros vão pro log.
//
// Payload esperado:
//   {
//     severity: 'critical' | 'warn' | 'info',
//     category: string,
//     title: string,
//     body: string,
//     context?: Record<string, unknown>
//   }

// deno-lint-ignore-file no-explicit-any

interface AlertPayload {
  severity: 'critical' | 'warn' | 'info';
  category: string;
  title: string;
  body: string;
  context?: Record<string, unknown>;
}

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_TOKEN');
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🚨',
  warn: '⚠️',
  info: 'ℹ️',
};

// Telegram MarkdownV2 reserved chars that need escaping
function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}

// URL precisa ser válida pra virar link clicável no MarkdownV2.
function isHttpUrl(s: unknown): s is string {
  return typeof s === 'string' && /^https?:\/\/[^\s)]+$/.test(s);
}

function formatMessage(p: AlertPayload): string {
  const title = escapeMd(p.title);
  const body = escapeMd(p.body);
  const ctx = p.context ?? {};

  // ───────────────────────────────────────────────────────────────
  // INFO = mensagem AMIGÁVEL, visível pros participantes do bolão.
  // Sem cabeçalho técnico, sem bloco de contexto (que pode vazar email/id),
  // sem link de dashboard, sem timestamp ISO. Só título + corpo + CTA opcional.
  // O CTA vem em context.cta_url / context.cta_label.
  // ───────────────────────────────────────────────────────────────
  if (p.severity === 'info') {
    let msg = `*${title}*\n\n${body}`;
    if (isHttpUrl(ctx.cta_url)) {
      const label = typeof ctx.cta_label === 'string' && ctx.cta_label ? ctx.cta_label : 'Abrir';
      // No (url) do MarkdownV2 só precisamos escapar ')' e '\'.
      const safeUrl = ctx.cta_url.replace(/[\\)]/g, (c) => '\\' + c);
      msg += `\n\n[${escapeMd(label)}](${safeUrl})`;
    }
    return msg;
  }

  // ───────────────────────────────────────────────────────────────
  // CRITICAL / WARN = alerta de bug/segurança. Como o chat é compartilhado
  // com os participantes, mantemos enxuto: emoji de urgência + título +
  // corpo + link de dashboard. SEM "[categoria]", SEM bloco Contexto, SEM
  // timestamp ISO — tudo isso fica salvo em public.alert_log pra forense.
  // ───────────────────────────────────────────────────────────────
  const emoji = SEVERITY_EMOJI[p.severity] ?? '•';

  let msg = `${emoji} *${title}*\n\n${body}`;

  // Link pro dashboard (útil pro admin investigar)
  if (SUPABASE_URL) {
    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1];
    if (projectRef) {
      const dashUrl = `https://supabase.com/dashboard/project/${projectRef}`;
      msg += `\n\n[Abrir dashboard](${dashUrl})`;
    }
  }

  return msg;
}

async function sendTelegram(text: string): Promise<{ ok: boolean; message_id?: number; error?: string }> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    return { ok: false, error: 'Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID env var' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
    });

    const data: any = await res.json();
    if (!data.ok) {
      // Tenta de novo sem markdown caso o escape tenha quebrado
      const fallback = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text.replace(/\\/g, ''),  // strips escape chars
        }),
      });
      const fbData: any = await fallback.json();
      if (fbData.ok) {
        return { ok: true, message_id: fbData.result.message_id };
      }
      return { ok: false, error: `Telegram: ${data.description || 'unknown'}` };
    }

    return { ok: true, message_id: data.result.message_id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function validatePayload(body: unknown): { valid: true; payload: AlertPayload } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') return { valid: false, error: 'body must be object' };
  const b = body as any;
  if (!b.severity || !['critical', 'warn', 'info'].includes(b.severity)) {
    return { valid: false, error: 'severity must be critical|warn|info' };
  }
  if (!b.category || typeof b.category !== 'string') return { valid: false, error: 'category is required' };
  if (!b.title || typeof b.title !== 'string') return { valid: false, error: 'title is required' };
  if (!b.body || typeof b.body !== 'string') return { valid: false, error: 'body is required' };
  return { valid: true, payload: b as AlertPayload };
}

Deno.serve(async (req) => {
  // Always return 200 so triggers don't fail
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST only' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const v = validatePayload(body);
  if (!v.valid) {
    console.error('[telegram-alert] invalid payload:', v.error, body);
    return new Response(JSON.stringify({ ok: false, error: v.error }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const text = formatMessage(v.payload);
  const result = await sendTelegram(text);

  if (!result.ok) {
    console.error('[telegram-alert] send failed:', result.error, v.payload);
  } else {
    console.log('[telegram-alert] sent:', v.payload.category, v.payload.title);
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
