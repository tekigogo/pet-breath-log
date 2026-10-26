// Receives a breathing record from an Apple Shortcut (Siri).
// Auth: a personal token created in the app (only its SHA-256 hash is stored).
// Deploy with verify_jwt = false (the function checks the token itself).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

function reply(status: number, text: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ok: status === 200, message: text, ...extra }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, '只接受 POST');
  let body: any;
  try { body = await req.json(); } catch { return reply(400, '格式不对，需要 JSON'); }

  const token = String(body.token || '');
  if (!/^pbl_[0-9a-f]{48}$/.test(token)) return reply(401, '令牌不对');
  let rpm = Number(body.rpm);
  const count = body.count != null && body.count !== '' ? Number(body.count) : null;
  const dur = body.duration_sec != null && body.duration_sec !== '' ? Number(body.duration_sec) : null;
  if ((!rpm || isNaN(rpm)) && count && dur) rpm = Math.round(count * 60 / dur);
  rpm = Math.round(rpm);
  if (!(rpm >= 5 && rpm <= 150)) return reply(400, '次数不对，要在 5 到 150 之间');
  const asleep = !(body.asleep === false || body.asleep === 'false' || body.asleep === 0 || body.asleep === '0');
  const note = String(body.note || '').slice(0, 200);

  const { data: tok } = await admin.from('api_tokens').select('id, user_id, household_id').eq('token_hash', await sha256hex(token)).maybeSingle();
  if (!tok) return reply(401, '令牌不对或已删除');
  const { data: member } = await admin.from('members').select('user_id').eq('household_id', tok.household_id).eq('user_id', tok.user_id).maybeSingle();
  if (!member) return reply(403, '你已不在这个家庭');
  const { data: pet } = await admin.from('pets').select('id, name, warn_yellow, warn_red').eq('household_id', tok.household_id).order('created_at').limit(1).single();
  if (!pet) return reply(400, '还没有宠物');

  const { error } = await admin.from('records').insert({
    pet_id: pet.id, household_id: tok.household_id, rpm, method: 'siri',
    count: count && !isNaN(count) ? Math.round(count) : null, dur: dur && !isNaN(dur) ? Math.round(dur) : null,
    asleep, note, created_by: tok.user_id
  });
  if (error) return reply(500, '保存失败，请在 App 里再记一次');
  await admin.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', tok.id);

  let zone = '低于 ' + pet.warn_yellow;
  if (rpm > pet.warn_red) zone = '高于红线 ' + pet.warn_red + '，猫还在熟睡时请再数一次';
  else if (rpm >= pet.warn_yellow) zone = '在黄线范围';
  const msg = '已记录 ' + pet.name + ' ' + rpm + ' 次每分钟，' + (asleep ? zone : '醒着，不判断警戒') + '。';
  return reply(200, msg, { rpm });
});
