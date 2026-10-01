const express = require('express');
const line = require('@line/bot-sdk');

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemma-2-27b-it', // ถ้าใช้ไม่ได้ ลอง gemma-3-27b-it
  NICKNAMES = 'มิจิ,miji,miju,มิจู,ปิง,ping,หนูมิจิ',
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

async function askGemini(room, speaker, reason) {
  const chat = room.history.map((h) => `${h.name}: ${h.text}`).join('\n');
  const members = [...new Set(room.members.values())].join(', ');
  const prompt = `${SYSTEM}

สมาชิกที่มิจิรู้จักในกลุ่ม: ${members}
คนที่เพิ่งพิมพ์ข้อความล่าสุด: ${speaker}
สถานการณ์: ${reason}

แชทล่าสุด:
${chat}

มิจิควรตอบอะไร? (ถ้าไม่ควรพูด ตอบ SKIP)`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.8 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
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

async function send(event, room, userId, text) {
  const r = await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text }],
  });
  r.sentMessages?.forEach((m) => botMsgIds.add(m.id));
  if (botMsgIds.size > 2000) botMsgIds.clear();
  room.lastReply = Date.now();
  room.history.push({ name: 'มิจิ', text });
  if (userId) room.active.set(userId, Date.now()); // คุยกับคนนี้อยู่ รีเซ็ตนับ 5 นาที
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
  const lastActive = room.active.get(userId) || 0;
  const isActive = Date.now() - lastActive < ACTIVE_MS;

  try {
    // 1) ถูกเรียกชื่อ/แท็ก/กด Reply/แชทส่วนตัว
    if (isPrivate || mentioned || called || quotedBot) {
      // เรียกชื่อเฉยๆ -> ตอบแบบคนจริงๆ "ว่าไง" แล้วรอฟัง (ไม่เสียโควต้า)
      let rest = lower;
      BOT_NAMES.forEach((n) => (rest = rest.split(n).join('')));
      rest = rest.replace(/[\s!?.,~ๆ@น้อง]+/g, '');
      if ((called || mentioned) && rest.length <= 2) {
        const ack = ACKS[Math.floor(Math.random() * ACKS.length)];
        return send(event, room, userId, ack);
      }
      const reply = await askGemini(room, name, `${name} กำลังคุยกับมิจิโดยตรง`);
      if (reply && !reply.toUpperCase().startsWith('SKIP')) return send(event, room, userId, reply);
      return;
    }

    // 2) คนที่เพิ่งคุยกับมิจิ (ยังไม่เกิน 5 นาที) -> ให้ AI ตัดสินเองว่าพูดกับมิจิอยู่ไหม
    if (isActive) {
      const reply = await askGemini(
        room,
        name,
        `${name} เพิ่งคุยกับมิจิเมื่อไม่นานนี้ ตัดสินจากบริบทว่าข้อความล่าสุดนี้พูดกับมิจิต่อหรือพูดกับคนอื่นในกลุ่ม ถ้าพูดกับคนอื่นให้ SKIP`
      );
      if (reply && !reply.toUpperCase().startsWith('SKIP')) return send(event, room, userId, reply);
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
    console.error(e.message);
  }
}

const app = express();
app.get('/', (_, res) => res.send('Miji is awake 🐭'));
app.post('/webhook', line.middleware({ channelSecret: LINE_CHANNEL_SECRET }), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(() => res.sendStatus(200));
});
app.listen(PORT, () => console.log(`Miji listening on ${PORT}`));
