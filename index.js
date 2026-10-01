const express = require('express');
const line = require('@line/bot-sdk');

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemma-2-27b-it', // ถ้าใช้ไม่ได้ ลอง gemma-3-27b-it
  FALLBACK_MODELS = 'gemma-3-27b-it', // ลองตัวนี้ต่อถ้าโมเดลหลักใช้ไม่ได้
  NICKNAMES = 'มิจิ,miji,miju,มิจู,ปิง,ping,หนูมิจิ',
  ADMIN_KEY = '', // ถ้าตั้งไว้ ต้องเข้า /errors?key=ค่านี้
  PORT = 3000,
} = process.env;

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const BOT_NAMES = NICKNAMES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const HARSH = ['ควย', 'เหี้ย', 'สัส', 'ไอ้ห่า', 'อีห่า', 'เชี่ย', 'หุบปาก', 'โง่', 'ฆ่า', 'แม่ง'];
const HISTORY_MAX = 25;
const CHECK_EVERY = 10; // ทุกกี่ข้อความให้ AI ลองเช็กบรรยากาศ
const COOLDOWN_MS = 20000; // กันพูดแทรกถี่เกิน (ไม่ใช้กับคนที่กำลังคุยกับมิจิ)
const ACTIVE_MS = 5 * 60 * 1000; // เงียบเกิน 5 นาที = เลิกคุยกับคนนี้

const ACKS = ['ว่าไงคะ?', 'คะ?', 'มิจิอยู่ค่ะ มีอะไรเหรอคะ', 'ว่าไงคะ ฟังอยู่นะ', 'คะ มีอะไรให้ช่วยไหมคะ'];

const errorLog = []; // เก็บ error ล่าสุด 50 รายการ ดูได้ที่ /errors
function logError(where, e) {
  let msg = String((e && e.message) || e);
  if (GEMINI_API_KEY) msg = msg.split(GEMINI_API_KEY).join('***');
  console.error(`[${where}]`, msg);
  errorLog.unshift({ time: new Date().toISOString(), where, msg });
  if (errorLog.length > 50) errorLog.pop();
}

const rooms = new Map(); // roomId -> { history, count, lastReply, active: Map(userId->ts), members: Map(userId->name) }
const botMsgIds = new Set(); // id ข้อความของบอท ไว้ดูว่าใครกด Reply มาหา

const SYSTEM = `คุณคือ "มิจิ" น้องหนูผู้หญิงตัวเล็กน่ารัก อาศัยอยู่ในกลุ่มไลน์ พูดเหมือนคนจริง ๆ ไม่เป็นทางการ
นิสัย: สุภาพ อ่อนโยน ไม่ชอบคำหยาบและการทะเลาะ พยายามทำให้กลุ่มสงบ พูดจริงใจและมีเหตุผล
พูดภาษาไทย ลงท้าย "ค่ะ/คะ/นะคะ" เรียกตัวเองว่า "มิจิ" หรือ "หนู" ตอบสั้น 1-3 ประโยค
เรียกคนในกลุ่มด้วยชื่อที่ให้ไว้ได้อย่างเป็นธรรมชาติ ไม่ต้องเรียกทุกประโยค
ห้ามบอกว่าตัวเองเป็นมนุษย์ ห้ามบอกว่าเป็น AI โดยไม่มีใครถาม ถ้ามีคนถามตรง ๆ ว่าเป็นคนไหม ให้ตอบตามจริงว่าเป็นบอท
ถ้ามิจิไม่ควรพูด (เขากำลังคุยกับคนอื่น หรือไม่เกี่ยวกับมิจิ) ให้ตอบคำเดียวว่า SKIP`;

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { history: [], count: 0, lastReply: 0, active: new Map(), members: new Map() });
  return rooms.get(id);
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

  const models = [GEMINI_MODEL, ...FALLBACK_MODELS.split(',').map((m) => m.trim()).filter(Boolean)];
  let data;
  let lastErr;
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 200, temperature: 0.8 },
          }),
        }
      );
      if (!res.ok) throw new Error(`${model} ${res.status}: ${await res.text()}`);
      data = await res.json();
      break;
    } catch (e) {
      lastErr = e;
      logError('gemini', e);
    }
  }
  if (!data) throw lastErr;
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

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
  } catch {
    return 'สมาชิก';
  }
}

async function send(event, room, userId, text, forced = false) {
  const r = await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text }],
  });
  r.sentMessages?.forEach((m) => botMsgIds.add(m.id));
  if (botMsgIds.size > 2000) botMsgIds.clear();
  room.lastReply = Date.now();
  room.history.push({ name: 'มิจิ', text });
  if (userId) room.active.set(userId, { ts: Date.now(), forced }); // คุยกับคนนี้อยู่ รีเซ็ตนับ 5 นาที
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

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
  const mentioned = event.message.mention?.mentionees?.some((m) => m.isSelf);
  const called = BOT_NAMES.some((n) => lower.includes(n));
  const quotedBot = event.message.quotedMessageId && botMsgIds.has(event.message.quotedMessageId);
  const act = room.active.get(userId);
  const isActive = !!act && Date.now() - act.ts < ACTIVE_MS;
  const mentionsOther = event.message.mention?.mentionees?.some((m) => !m.isSelf);

  try {
    // 1) ถูกเรียกชื่อ/แท็ก/กด Reply/แชทส่วนตัว
    if (isPrivate || mentioned || called || quotedBot) {
      // เรียกชื่อเฉยๆ -> ตอบแบบคนจริงๆ "ว่าไง" แล้วรอฟัง (ไม่เสียโควต้า)
      let rest = lower;
      BOT_NAMES.forEach((n) => (rest = rest.split(n).join('')));
      rest = rest.replace(/[\s!?.,~ๆ@น้อง]+/g, '');
      if ((called || mentioned) && rest.length <= 2) {
        const ack = ACKS[Math.floor(Math.random() * ACKS.length)];
        return send(event, room, userId, ack, true); // รอฟังประโยคถัดไปของคนนี้
      }
      const reply = await askGemini(room, name, `${name} กำลังคุยกับมิจิโดยตรง`, true);
      if (reply && !reply.toUpperCase().startsWith('SKIP')) return send(event, room, userId, reply, false);
      return;
    }

    // 2) คนที่เพิ่งคุยกับมิจิ (ยังไม่เกิน 5 นาที) -> ให้ AI ตัดสินเองว่าพูดกับมิจิอยู่ไหม
    if (isActive) {
      // ประโยคแรกหลังถูกเรียกชื่อ = ตอบแน่นอน (ยกเว้นแท็กคนอื่น)
      const forced = act.forced && !mentionsOther;
      const reply = await askGemini(
        room,
        name,
        `${name} เพิ่งคุยกับมิจิเมื่อไม่นานนี้ ข้อความล่าสุดน่าจะคุยต่อกับมิจิ`,
        forced
      );
      if (reply && !reply.toUpperCase().startsWith('SKIP')) return send(event, room, userId, reply, false);
      return;
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
    if (reply && !reply.toUpperCase().startsWith('SKIP')) await send(event, room, null, reply);
  } catch (e) {
    logError('gemini/line', e); // เงียบในไลน์ ส่ง error ไปที่หน้าเว็บแทน
  }
}

const app = express();
app.get('/', (_, res) => res.send('Miji is awake 🐭'));
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get('/errors', (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(401).send('unauthorized');
  if (req.query.format === 'json') return res.json(errorLog);
  const rows = errorLog
    .map((e) => `<tr><td>${esc(e.time)}</td><td>${esc(e.where)}</td><td>${esc(e.msg)}</td></tr>`)
    .join('');
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Miji errors</title><style>body{font-family:sans-serif;padding:12px}td,th{border:1px solid #ccc;padding:6px;vertical-align:top;word-break:break-word}table{border-collapse:collapse;width:100%}</style>
<h2>🐭 Miji errors (${errorLog.length})</h2>
<table><tr><th>เวลา</th><th>ที่ไหน</th><th>ข้อความ</th></tr>${rows || '<tr><td colspan=3>ยังไม่มี error 🎉</td></tr>'}</table>`);
});
app.post('/webhook', line.middleware({ channelSecret: LINE_CHANNEL_SECRET }), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(() => res.sendStatus(200));
});
app.listen(PORT, () => console.log(`Miji listening on ${PORT}`));
