const express = require('express');
const line = require('@line/bot-sdk');

// ---------- ตั้งค่า (อ่านจาก Environment ของ Render, ตัดช่องว่างให้อัตโนมัติ) ----------
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const LINE_CHANNEL_ACCESS_TOKEN = env('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_CHANNEL_SECRET = env('LINE_CHANNEL_SECRET');
const GEMINI_API_KEY = env('GEMINI_API_KEY');
const GEMINI_MODEL = env('GEMINI_MODEL', 'gemma-3-27b-it');
const FALLBACK_MODELS = env('FALLBACK_MODELS', 'gemma-3-12b-it,gemini-flash-lite-latest');
const NICKNAMES = env('NICKNAMES', 'มิจิ,miji,miju,มิจู,ปิง,ping,หนูมิจิ');
const ADMIN_KEY = env('ADMIN_KEY');
const PORT = env('PORT', '3000');

const BOT_NAMES = NICKNAMES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const HARSH = ['ควย', 'เหี้ย', 'สัส', 'ไอ้ห่า', 'อีห่า', 'เชี่ย', 'หุบปาก', 'โง่', 'ฆ่า', 'แม่ง'];
const HISTORY_MAX = 25;
const CHECK_EVERY = 10; // ทุกกี่ข้อความให้ AI ลองเช็กบรรยากาศ
const COOLDOWN_MS = 20000; // กันพูดแทรกถี่เกิน (ไม่ใช้กับคนที่กำลังคุยกับมิจิ)
const ACTIVE_MS = 5 * 60 * 1000; // เงียบเกิน 5 นาที = เลิกฟังคนนั้น
const GEMINI_TIMEOUT_MS = 8000;
const ACKS = [
  'ว่าไงคะ?', 'คะ?', 'มิจิอยู่ค่ะ มีอะไรเหรอคะ', 'ว่าไงคะ ฟังอยู่นะ', 'คะ มีอะไรให้ช่วยไหมคะ',
  'อ๊ะ เรียกมิจิเหรอคะ', 'คะ ว่ามาเลยค่ะ', 'มิจิฟังอยู่นะคะ', 'ค่ะ มีอะไรคะ',
];

// ---------- log (ดูได้ที่หน้า /errors) ----------
const logs = [];
function addLog(level, where, msg) {
  let m = String((msg && msg.message) || msg);
  if (GEMINI_API_KEY) m = m.split(GEMINI_API_KEY).join('***');
  logs.unshift({ time: new Date().toISOString(), level, where, msg: m });
  if (logs.length > 120) logs.pop();
  (level === 'error' ? console.error : console.log)(`[${where}]`, m);
}
const logError = (where, e) => addLog('error', where, e);
const trace = (msg) => addLog('info', 'trace', msg);

process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
process.on('uncaughtException', (e) => logError('uncaughtException', e));

if (!LINE_CHANNEL_ACCESS_TOKEN) logError('startup', 'ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN');
if (!LINE_CHANNEL_SECRET) logError('startup', 'ยังไม่ได้ตั้ง LINE_CHANNEL_SECRET');
if (!GEMINI_API_KEY) logError('startup', 'ยังไม่ได้ตั้ง GEMINI_API_KEY');

const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN });

// ---------- state ----------
const rooms = new Map(); // roomId -> { history, count, lastReply, active: Map(userId -> {ts, forced}), members: Map(userId -> name) }
const botMsgIds = new Set();
const seenEvents = new Set();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { history: [], count: 0, lastReply: 0, active: new Map(), members: new Map() });
  return rooms.get(id);
}

// ---------- Gemini ----------
const SYSTEM = `คุณคือ "มิจิ" น้องหนูผู้หญิงตัวเล็กน่ารัก อาศัยอยู่ในกลุ่มไลน์ พูดเหมือนคนจริง ๆ ไม่เป็นทางการ
นิสัย: สุภาพ อ่อนโยน ไม่ชอบคำหยาบและการทะเลาะ พยายามทำให้กลุ่มสงบ พูดจริงใจและมีเหตุผล
พูดภาษาไทย ลงท้าย "ค่ะ/คะ/นะคะ" เรียกตัวเองว่า "มิจิ" หรือ "หนู" ตอบสั้น 1-3 ประโยค
เรียกคนในกลุ่มด้วยชื่อที่ให้ไว้ได้อย่างเป็นธรรมชาติ ไม่ต้องเรียกทุกประโยค
ห้ามบอกว่าตัวเองเป็นมนุษย์ ห้ามบอกว่าเป็น AI โดยไม่มีใครถาม ถ้ามีคนถามตรง ๆ ว่าเป็นคนไหม ให้ตอบตามจริงว่าเป็นบอท
ตอบเฉพาะข้อความที่มิจิจะพูดเท่านั้น ห้ามขึ้นต้นด้วยชื่อ เช่น "มิจิ:"
ถ้ามิจิไม่ควรพูด (เขากำลังคุยกับคนอื่น หรือไม่เกี่ยวกับมิจิ) ให้ตอบคำเดียวว่า SKIP`;

let preferredModel = null; // โมเดลที่เคยใช้ได้ล่าสุด ลองก่อนเสมอ
let discovered = null;

const apiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

async function listModels() {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GEMINI_API_KEY}`,
    { signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) }
  );
  const body = await res.text();
  if (!res.ok) throw new Error(`listModels ${res.status}: ${body.slice(0, 300)}`);
  return (JSON.parse(body).models || [])
    .filter((m) => m.name && (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}

async function discoverModel() {
  if (discovered && Date.now() - discovered.ts < 10 * 60 * 1000) return discovered.name;
  const names = await listModels();
  const pick =
    names.find((n) => n === 'gemma-3-27b-it') ||
    names.find((n) => /^gemma-3-.*-it$/.test(n)) ||
    names.find((n) => /^gemma-.*-it$/.test(n)) ||
    names.find((n) => /flash-lite/.test(n)) ||
    names.find((n) => /flash/.test(n)) ||
    null;
  discovered = { ts: Date.now(), name: pick };
  if (pick) trace(`ค้นหาโมเดลอัตโนมัติ: เจอ ${pick}`);
  return pick;
}

async function callModel(model, prompt) {
  const res = await fetch(apiUrl(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 250, temperature: 0.8 },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`${model} ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = JSON.parse(body);
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return { text, reason: cand?.finishReason || data.promptFeedback?.blockReason || 'ไม่ทราบ' };
}

function cleanReply(t) {
  return t
    .replace(/^\s*(มิจิ|miji)\s*[:：]\s*/i, '')
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim()
    .slice(0, 800);
}

async function askGemini(room, speaker, reason, forced = false) {
  const chat = room.history.map((h) => `${h.name}: ${h.text}`).join('\n');
  const members = [...new Set(room.members.values())].join(', ');
  const prompt = `${SYSTEM}

สมาชิกที่มิจิรู้จักในกลุ่ม: ${members}
คนที่เพิ่งพิมพ์ข้อความล่าสุด: ${speaker}
สถานการณ์: ${reason}

แชทล่าสุด:
${chat}

${forced ? 'ข้อความนี้พูดกับมิจิแน่นอน ห้ามตอบ SKIP ให้ตอบเหมือนคนคุยกันทั่วไป' : 'ถ้าไม่แน่ใจว่าพูดกับใคร ให้เอนไปทางตอบ ถ้าชัดเจนว่าพูดกับคนอื่นให้ SKIP'}
มิจิควรตอบอะไร?`;

  const models = [...new Set([preferredModel, GEMINI_MODEL, ...FALLBACK_MODELS.split(',').map((m) => m.trim())].filter(Boolean))].slice(0, 3);
  let lastErr;
  let sawNotFound = false;

  const tryModel = async (model) => {
    try {
      const r = await callModel(model, prompt);
      preferredModel = model;
      return r;
    } catch (e) {
      lastErr = e;
      if (e.status === 404 || e.status === 400) sawNotFound = true;
      logError('gemini', e.name === 'TimeoutError' ? `${model} timeout เกิน ${GEMINI_TIMEOUT_MS / 1000} วินาที` : e);
      return null;
    }
  };

  let result = null;
  for (const m of models) {
    result = await tryModel(m);
    if (result) break;
  }
  if (!result && sawNotFound) {
    try {
      const m = await discoverModel();
      if (m && !models.includes(m)) result = await tryModel(m);
    } catch (e) {
      logError('discover', e);
    }
  }
  if (!result) throw lastErr || new Error('Gemini ไม่ตอบ');

  const out = cleanReply(result.text);
  if (forced && (!out || out.toUpperCase().startsWith('SKIP'))) {
    logError('empty-reply', `AI ตอบว่าง/SKIP ทั้งที่ถูกเรียกตรง ๆ (finishReason: ${result.reason})`);
  }
  return out;
}

// ---------- LINE ----------
async function fetchName(event) {
  const { userId, groupId, roomId } = event.source;
  if (!userId) return 'ใครสักคน';
  try {
    const p = groupId
      ? await client.getGroupMemberProfile(groupId, userId)
      : roomId
      ? await client.getRoomMemberProfile(roomId, userId)
      : await client.getProfile(userId);
    return p.displayName;
  } catch (e) {
    logError('profile', e);
    return 'สมาชิก';
  }
}

function hasName(lower) {
  return BOT_NAMES.some((n) =>
    /^[a-z0-9]+$/.test(n) ? new RegExp(`(^|[^a-z0-9])${n}([^a-z0-9]|$)`).test(lower) : lower.includes(n)
  );
}

async function send(event, room, userId, text, forced = false) {
  const r = await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text }],
  });
  r?.sentMessages?.forEach((m) => botMsgIds.add(m.id));
  if (botMsgIds.size > 2000) botMsgIds.clear();
  room.lastReply = Date.now();
  room.history.push({ name: 'มิจิ', text });
  if (userId) room.active.set(userId, { ts: Date.now(), forced }); // คุยกับคนนี้อยู่ รีเซ็ตนับ 5 นาที
}

const isSkip = (r) => !r || r.toUpperCase().startsWith('SKIP');

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  if (event.webhookEventId) {
    if (seenEvents.has(event.webhookEventId)) return; // กันส่งซ้ำ
    seenEvents.add(event.webhookEventId);
    if (seenEvents.size > 1000) seenEvents.clear();
  }

  const text = event.message.text;
  const userId = event.source.userId;
  const roomId = event.source.groupId || event.source.roomId || userId;
  const room = getRoom(roomId);

  // รู้จักชื่อทุกคน (จำไว้ต่อห้อง)
  if (userId && !room.members.has(userId)) room.members.set(userId, await fetchName(event));
  const name = room.members.get(userId) || 'สมาชิก';

  // อ่านทุกข้อความ
  room.history.push({ name, text });
  if (room.history.length > HISTORY_MAX) room.history.shift();
  room.count++;

  const lower = text.toLowerCase();
  const isPrivate = event.source.type === 'user';
  const mentionees = event.message.mention?.mentionees || [];
  const mentioned = mentionees.some((m) => m.isSelf);
  const mentionsOther = mentionees.some((m) => !m.isSelf);
  const called = hasName(lower);
  const quotedBot = !!event.message.quotedMessageId && botMsgIds.has(event.message.quotedMessageId);
  const act = room.active.get(userId);
  const isActive = !!act && Date.now() - act.ts < ACTIVE_MS;
  const who = `${name}${isPrivate ? ' (แชทส่วนตัว)' : ''}`;

  try {
    // 1) ถูกเรียกชื่อ/แท็ก/กด Reply/แชทส่วนตัว
    if (isPrivate || mentioned || called || quotedBot) {
      // เรียกชื่อเฉย ๆ -> ตอบสั้นแบบคนจริง ๆ แล้วรอฟังประโยคถัดไป (ไม่เสียโควต้า)
      let rest = lower;
      BOT_NAMES.forEach((n) => (rest = rest.split(n).join('')));
      rest = rest.replace(/(น้อง|หนู)/g, '').replace(/[\s!?.,~ๆ@]+/g, '');
      if ((called || mentioned) && rest.length <= 2) {
        const ack = ACKS[Math.floor(Math.random() * ACKS.length)];
        await send(event, room, userId, ack, true);
        trace(`${who}: เรียกชื่อ → ทัก "${ack}" แล้วรอฟัง`);
        return;
      }
      const reply = await askGemini(room, name, `${name} กำลังคุยกับมิจิโดยตรง`, true);
      if (isSkip(reply)) return trace(`${who}: คุยตรง แต่ AI ไม่ตอบ`);
      await send(event, room, userId, reply, false);
      return trace(`${who}: คุยตรง → ตอบแล้ว (${reply.length} ตัวอักษร)`);
    }

    // 2) คนที่เพิ่งคุยกับมิจิ (ยังไม่เกิน 5 นาที)
    if (isActive) {
      const forced = act.forced && !mentionsOther; // ประโยคแรกหลังถูกเรียก = ตอบแน่นอน
      const reply = await askGemini(
        room,
        name,
        `${name} เพิ่งคุยกับมิจิเมื่อไม่นานนี้ ข้อความล่าสุดน่าจะคุยต่อกับมิจิ`,
        forced
      );
      if (isSkip(reply)) return trace(`${who}: กำลังคุยอยู่ แต่ AI เห็นว่าไม่ได้คุยกับมิจิ`);
      await send(event, room, userId, reply, false);
      return trace(`${who}: คุยต่อ → ตอบแล้ว (${reply.length} ตัวอักษร)`);
    }

    // 3) คำหยาบ / เช็กบรรยากาศเป็นระยะ (มี cooldown)
    if (Date.now() - room.lastReply < COOLDOWN_MS) return;
    const harsh = HARSH.some((w) => lower.includes(w));
    const periodic = room.count % CHECK_EVERY === 0;
    if (!harsh && !periodic) return;
    const reply = await askGemini(
      room,
      name,
      harsh ? 'มีคำหยาบ/บรรยากาศเริ่มตึง ช่วยทำให้กลุ่มสงบอย่างอ่อนโยน' : 'เช็กบรรยากาศ พูดเฉพาะถ้าควรจริง ๆ ไม่งั้น SKIP'
    );
    if (isSkip(reply)) return trace(`${who}: ${harsh ? 'คำหยาบ' : 'เช็กบรรยากาศ'} → AI เลือกเงียบ`);
    await send(event, room, null, reply);
    trace(`${who}: ${harsh ? 'คำหยาบ' : 'เช็กบรรยากาศ'} → แทรกตอบแล้ว`);
  } catch (e) {
    logError('handleEvent', e); // เงียบในไลน์ ส่ง error ไปที่หน้าเว็บแทน
  }
}

// ---------- เว็บ ----------
const app = express();
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const guard = (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) {
    res.status(401).send('unauthorized');
    return false;
  }
  return true;
};
const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:sans-serif;padding:12px}td,th{border:1px solid #ccc;padding:6px;vertical-align:top;word-break:break-word}table{border-collapse:collapse;width:100%}.e{background:#fee}</style>${body}`;

app.get('/', (_, res) => res.send('Miji is awake 🐭'));

app.get('/errors', (req, res) => {
  if (!guard(req, res)) return;
  if (req.query.format === 'json') return res.json(logs);
  const rows = logs
    .map(
      (e) =>
        `<tr class="${e.level === 'error' ? 'e' : ''}"><td>${esc(e.time.slice(11, 19))}</td><td>${e.level === 'error' ? '❌' : 'ℹ️'} ${esc(e.where)}</td><td>${esc(e.msg)}</td></tr>`
    )
    .join('');
  res.send(page('Miji logs', `<h2>🐭 Miji logs (${logs.length})</h2><p>แดง = error / ขาว = บอทตัดสินใจทำอะไร (เวลา UTC)</p><table><tr><th>เวลา</th><th>ที่ไหน</th><th>ข้อความ</th></tr>${rows || '<tr><td colspan=3>ยังไม่มี log</td></tr>'}</table>`));
});

app.get('/test', async (req, res) => {
  if (!guard(req, res)) return;
  const q = String(req.query.q || 'เป็นยังไงบ้าง');
  const room = { history: [{ name: 'ทดสอบ', text: q }], members: new Map([['t', 'ทดสอบ']]) };
  try {
    const out = await askGemini(room, 'ทดสอบ', 'ทดสอบระบบ ตอบข้อความนี้', true);
    res.send(page('test', `<p>ถาม: ${esc(q)}</p><p>มิจิตอบ: ${esc(out || '(ว่าง)')}</p><p>โมเดลที่ใช้ได้: ${esc(preferredModel)}</p>`));
  } catch (e) {
    res.status(500).send(page('test', `<p>❌ ${esc(e.message)}</p><p>ลองดู <a href="/models${ADMIN_KEY ? '?key=' + esc(ADMIN_KEY) : ''}">/models</a> ว่าคีย์นี้ใช้โมเดลอะไรได้</p>`));
  }
});

app.get('/models', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const names = await listModels();
    res.send(page('models', `<h3>โมเดลที่คีย์นี้เรียกได้ (${names.length})</h3><p>ตอนนี้ตั้งไว้: ${esc(GEMINI_MODEL)}</p><ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`));
  } catch (e) {
    res.status(500).send(page('models', `<p>❌ ${esc(e.message)}</p>`));
  }
});

app.post('/webhook', line.middleware({ channelSecret: LINE_CHANNEL_SECRET }), (req, res) => {
  res.sendStatus(200); // ตอบ LINE ทันที แล้วค่อยประมวลผล กัน timeout
  for (const ev of req.body.events || []) handleEvent(ev).catch((e) => logError('handleEvent', e));
});

app.use((err, req, res, next) => {
  logError('webhook', err); // เช่น Channel secret ผิด
  res.status(err instanceof line.SignatureValidationFailed ? 401 : err.statusCode || 500).send('error');
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Miji listening on ${PORT}`));
}
module.exports = { app, logs };
