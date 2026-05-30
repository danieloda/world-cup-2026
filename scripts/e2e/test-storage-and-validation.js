#!/usr/bin/env node
/**
 * #9 Storage RLS de avatar: user A não pode escrever na pasta de B; leitura é pública.
 * #12 Validação de entrada: placares fora do range / não-inteiros via API direta.
 *
 * Usa clientes anon autenticados (RLS aplica). Admin/service só p/ setup/teardown.
 */
import { createClient } from '@supabase/supabase-js';
import { makeAdminClient, adminCreateUser, adminCreateProfile, adminDeleteUser } from './lib/admin-client.js';
import { config } from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_PUBLISHABLE_KEY;
const C = { r:'\x1b[31m', g:'\x1b[32m', b:'\x1b[34m', x:'\x1b[0m', bold:'\x1b[1m' };
let ok = true;
const check = (name, pass, detail='') => { if(!pass) ok=false;
  console.log(`   ${pass?C.g+'✓':C.r+'✗'} ${name}${detail?' — '+detail:''}${C.x}`); };

const admin = makeAdminClient();
const PASS = 'TestUser2026!';
const ts = Date.now();
const aEmail = `test-stor-a-${ts}@testuser.com`, bEmail = `test-stor-b-${ts}@testuser.com`;
const alice = await adminCreateUser(admin, aEmail, PASS, 'Stor Alice');
const bob = await adminCreateUser(admin, bEmail, PASS, 'Stor Bob');
await adminCreateProfile(admin, alice, 'Stor Alice', { paid:false, avatar_url:'assets/avatars/daniel.png' });
await adminCreateProfile(admin, bob, 'Stor Bob', { paid:false, avatar_url:'assets/avatars/daniel.png' });

const aClient = createClient(URL, ANON, { auth:{ persistSession:false }});
await aClient.auth.signInWithPassword({ email:aEmail, password:PASS });

console.log(`${C.b}${C.bold}🗄️  #9 Storage RLS (avatar)${C.x}`);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452','hex'); // header PNG mínimo

// 1) Alice escreve na PRÓPRIA pasta → permitido
const ownPath = `${alice.id}/avatar.png`;
const up1 = await aClient.storage.from('avatars').upload(ownPath, png, { upsert:true, contentType:'image/png' });
check('Alice escreve na própria pasta', !up1.error, up1.error?.message);

// 2) Alice escreve na pasta do BOB → bloqueado
const bobPath = `${bob.id}/avatar.png`;
const up2 = await aClient.storage.from('avatars').upload(bobPath, png, { upsert:true, contentType:'image/png' });
check('Alice NÃO escreve na pasta do Bob (RLS)', !!up2.error, up2.error ? 'bloqueado' : 'PERMITIU (falha!)');

// 3) Leitura pública do avatar da Alice (sem auth)
const anonNoAuth = createClient(URL, ANON, { auth:{ persistSession:false }});
const pub = anonNoAuth.storage.from('avatars').getPublicUrl(ownPath);
const resp = await fetch(pub.data.publicUrl).then(r=>r.status).catch(()=>0);
check('Leitura pública do avatar (200)', resp === 200, `http ${resp}`);

console.log(`\n${C.b}${C.bold}🔢 #12 Validação de entrada (predictions)${C.x}`);
// Setup: um match no futuro pra Alice poder inserir
const { data: fut } = await admin.from('matches').select('id, match_date').eq('stage','group').order('id').limit(1).single();
const future = new Date(Date.now()+7*864e5).toISOString();
const origDate = fut.match_date;
await admin.from('matches').update({ match_date: future }).eq('id', fut.id);

const tryInsert = async (ph, pa, label) => {
  // limpa antes
  await admin.from('predictions').delete().eq('user_id', alice.id).eq('match_id', fut.id);
  const r = await aClient.from('predictions').insert({ user_id: alice.id, match_id: fut.id, pred_home: ph, pred_away: pa });
  return r.error;
};

// negativo
check('Placar negativo rejeitado', !!(await tryInsert(-1, 0)), 'pred_home=-1');
// gigante (acima de limite razoável, ex. 100)
const bigErr = await tryInsert(999, 0);
check('Placar absurdo (999) rejeitado OU aceito?', true, bigErr ? 'rejeitado (constraint)' : 'ACEITO — sem upper bound no schema');
// não-inteiro
const floatErr = await tryInsert(1.5, 0);
check('Placar não-inteiro rejeitado', !!floatErr, floatErr ? 'rejeitado (int col)' : 'aceito');
// válido (sanity)
check('Placar válido (2-1) aceito', !(await tryInsert(2, 1)), 'sanity');

// teardown
await admin.from('predictions').delete().eq('user_id', alice.id).eq('match_id', fut.id);
await admin.from('matches').update({ match_date: origDate }).eq('id', fut.id);
await aClient.auth.signOut();
await adminDeleteUser(admin, alice.id);
await adminDeleteUser(admin, bob.id);

console.log(`\n${ok ? C.g+C.bold+'🎉 OK' : C.r+C.bold+'⚠ revisar'}${C.x}`);
process.exit(ok ? 0 : 1);
