// Diagnóstico de conectividad del watcher. Corré esto en la MISMA ventana donde
// falla el watcher: el problema suele ser del entorno (proxy, DNS, VPN, certificados)
// y no del código.
//
//   node scripts/diag.js
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const RAIZ = path.join(__dirname, '..');

function causas(e) {
  const partes = [e.message];
  for (let c = e.cause; c; c = c.cause) partes.push(`${c.code ?? ''} ${c.message ?? ''}`.trim());
  return partes.join('\n     <- ');
}

(async () => {
  console.log('node            : ' + process.version);
  console.log('carpeta script  : ' + __dirname);

  const proxies = Object.entries(process.env)
    .filter(([k]) => /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(k));
  console.log('proxy en el entorno: ' + (proxies.length ? JSON.stringify(Object.fromEntries(proxies)) : '(ninguno)'));
  console.log('NODE_EXTRA_CA_CERTS: ' + (process.env.NODE_EXTRA_CA_CERTS ?? '(no seteado)'));

  const envPath = path.join(RAIZ, '.env.local');
  if (!fs.existsSync(envPath)) { console.log('\n.env.local  : NO existe en ' + RAIZ); return; }
  const env = fs.readFileSync(envPath, 'utf8');
  const val = k => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
  const url = val('NEXT_PUBLIC_SUPABASE_URL');
  const key = val('SUPABASE_SERVICE_ROLE_KEY');
  console.log('\n.env.local      : OK');
  console.log('  URL           : ' + (url ?? 'FALTA'));
  console.log('  service_role  : ' + (key ? 'presente' : 'FALTA'));
  if (!url || !key) return;

  const host = new URL(url).hostname;
  try {
    const ips = await dns.lookup(host, { all: true });
    console.log('\nDNS ' + host + ' -> ' + ips.map(i => i.address).join(', '));
  } catch (e) {
    console.log('\nDNS ' + host + ' -> FALLÓ: ' + causas(e));
    console.log('   (sin DNS no hay internet/VPN: revisá la conexión)');
    return;
  }

  try {
    const r = await fetch(url + '/rest/v1/', { headers: { apikey: key } });
    console.log('HTTPS a Supabase -> OK, status ' + r.status);
  } catch (e) {
    console.log('HTTPS a Supabase -> FALLÓ:\n     ' + causas(e));
    console.log('   ECONNREFUSED/ETIMEDOUT = firewall o proxy corporativo');
    console.log('   errores de certificado = inspección SSL de la red');
    return;
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(url, key);
    const { error } = await sb.from('export_log').select('id').limit(1);
    console.log('tabla export_log -> ' + (error ? 'FALLÓ: ' + error.message : 'OK'));
  } catch (e) {
    console.log('tabla export_log -> FALLÓ: ' + causas(e));
  }

  const Z = 'Z:/FraccionamientoCQ/programación/PROG-LM.xlsm';
  console.log('archivo PROG-LM  -> ' + (fs.existsSync(Z) ? 'visible' : 'NO visible (¿Z: desconectada?)'));
  console.log('\nSi todo dice OK, el watcher tiene que andar: reinicialo.');
})();
