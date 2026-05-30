#!/usr/bin/env node
/**
 * #11 Concorrência: escritas paralelas no mesmo recurso (prediction) → sem corrupção.
 * #6  Alertas (019): trigger grava em alert_log mesmo sem entrega real no Telegram.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
import { makeAdminClient, adminCreateUser, adminCreateProfile, adminDeleteUser } from './lib/admin-client.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });
const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_PUBLISHABLE_KEY;
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', x:'\x1b[0m', bold:'\x1b[1m' };
let ok = true;
const check = (n,p,d='') => { if(!p) ok=false; console.log(`   ${p?C.g+'✓':C.r+'✗'} ${n}${d?' — '+d:''}${C.x}`); };

const admin = makeAdminClient();
const PASS='TestUser2026!'; const email=`test-conc-${Date.now()}@testuser.com`;
const u = await adminCreateUser(admin, email, PASS, 'Conc User');
await adminCreateProfile(admin, u, 'Conc User', { paid:true, avatar_url:'assets/avatars/daniel.png' });

console.log(`${C.b}${C.bold}🔀 #11 Concorrência (writes paralelos)${C.x}`);
// abre um match
const { data: m } = await admin.from('matches').select('id, match_date, finished, actual_home, actual_away, pen_winner, finished_at').eq('stage','group').order('id').limit(1).single();
const snap = { ...m };
await admin.from('matches').update({ match_date:new Date(Date.now()+7*864e5).toISOString(), finished:false, actual_home:null, actual_away:null, pen_winner:null, finished_at:null }).eq('id', m.id);

const uc = createClient(URL, ANON, { auth:{persistSession:false}});
await uc.auth.signInWithPassword({ email, password: PASS });

// 10 upserts paralelos no MESMO (user, match) com placares diferentes
const ups = Array.from({length:10}, (_,i) =>
  uc.from('predictions').upsert({ user_id:u.id, match_id:m.id, pred_home:i, pred_away:0 }, { onConflict:'user_id,match_id' })
);
const res = await Promise.all(ups);
const errs = res.filter(r=>r.error).length;
const rows = (await admin.from('predictions').select('pred_home').eq('user_id',u.id).eq('match_id',m.id)).data;
check('10 upserts paralelos → exatamente 1 linha (UNIQUE respeitado)', rows.length===1, `linhas=${rows.length}, erros=${errs}`);
check('valor final é um dos escritos (sem corrupção)', rows.length===1 && rows[0].pred_home>=0 && rows[0].pred_home<=9, `pred_home=${rows[0]?.pred_home}`);

// inserts paralelos puros (sem upsert) → só 1 vence, resto 23505
await admin.from('predictions').delete().eq('user_id',u.id).eq('match_id',m.id);
const inserts = Array.from({length:5}, (_,i) =>
  uc.from('predictions').insert({ user_id:u.id, match_id:m.id, pred_home:i, pred_away:1 })
);
const ires = await Promise.all(inserts);
const okIns = ires.filter(r=>!r.error).length;
const dupErr = ires.filter(r=>r.error && /duplicate|unique|23505/i.test(r.error.message)).length;
const finalRows = (await admin.from('predictions').select('*').eq('user_id',u.id).eq('match_id',m.id)).data.length;
check('5 inserts paralelos → 1 sucesso, demais bloqueados por UNIQUE', okIns===1 && finalRows===1, `ok=${okIns}, dupErr=${dupErr}, linhas=${finalRows}`);

await uc.auth.signOut();
await admin.from('predictions').delete().eq('user_id',u.id).eq('match_id',m.id);
await admin.from('matches').update(snap).eq('id', m.id);

console.log(`\n${C.b}${C.bold}🔔 #6 Alertas (019) gravam em alert_log${C.x}`);
const before = (await admin.from('alert_log').select('*',{count:'exact',head:true})).count;
// send_alert é a função usada por TODOS os triggers de alerta (007/019). Chamá-la
// diretamente exercita o caminho real de gravação em alert_log (o http_post pro Telegram
// é async via pg_net e não bloqueia/impede o insert).
const r = await admin.rpc('send_alert', {
  p_severity:'info', p_category:'test_e2e', p_title:'TESTE alert e2e',
  p_body:'verificação de gravação em alert_log', p_context:{ simulated:true }, p_dedup_seconds:0
});
if (r.error) console.log('   (send_alert rpc erro:', r.error.message, ')');
const after = (await admin.from('alert_log').select('*',{count:'exact',head:true})).count;
check('send_alert insere em alert_log (sem depender de entrega Telegram)', after === before+1, `antes=${before} depois=${after}`);
// limpa o alerta de teste
await admin.from('alert_log').delete().eq('category','test_e2e');

await adminDeleteUser(admin, u.id);
console.log(`\n${ok ? C.g+C.bold+'🎉 OK' : C.r+C.bold+'⚠ revisar'}${C.x}`);
process.exit(ok?0:1);
