const express = require('express');
const line = require('@line/bot-sdk');

// ---------- ตั้งค่า (อ่านจาก Environment ของ Render, ตัดช่องว่างให้อัตโนมัติ) ----------
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const LINE_CHANNEL_ACCESS_TOKEN = env('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_CHANNEL_SECRET = env('LINE_CHANNEL_SECRET');
const GEMINI_API_KEY = env('GEMINI_API_KEY');
const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-flash-lite-latest'); // โมเดลคุยข้อความ
const FALLBACK_MODELS = env('FALLBACK_MODELS', 'gemini-flash-latest,gemma-3-27b-it');
const MEDIA_MODEL = env('MEDIA_MODEL', 'gemini-flash-lite-latest'); // โมเดลอ่านรูป/ฟังเสียง (ต้องเป็น Gemini)
const NICKNAMES = env('NICKNAMES', 'มิจิ,miji,miju,มิจู,ปิง,ping,หนูมิจิ');
const ADMIN_KEY = env('ADMIN_KEY');
const PORT = env('PORT', '3000');

const BOT_NAMES = NICKNAMES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const HARSH = ['ควย', 'เหี้ย', 'สัส', 'ไอ้ห่า', 'อีห่า', 'เชี่ย', 'หุบปาก', 'โง่', 'ฆ่า', 'แม่ง'];
const HISTORY_MAX = 25;
const CHECK_EVERY = 10;
const COOLDOWN_MS = 20000;
const ACTIVE_MS = 5 * 60 * 1000; // เงียบเกิน 5 นาที = เลิกฟังคนนั้น
const TEXT_TIMEOUT_MS = 8000;
const MEDIA_TIMEOUT_MS = 20000;
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const MEDIA_HINT = /(รูป|ภาพ|เสียง|คลิป|ฟัง|ดู|นี่|นี้|พูดว่า|พูดอะไร|พูดไร|อ่าน|แปล|เมื่อกี้|ข้างบน)/;
const ACKS = ['ว่าไงคะ?', 'คะ?', 'หืม?', 'อยู่นี่ ๆ', 'ว่ามาเลย', 'ว่าไง', 'อะไรเหรอ', 'ว่า?', 'มาแล้วนะ', 'คะ ว่ามา'];

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
const rooms = new Map();
const botMsgIds = new Set();
const seenEvents = new Set();

function getRoom(id) {
  if (!rooms.has(id))
    rooms.set(id, { history: [], count: 0, lastReply: 0, active: new Map(), members: new Map(), media: [] });
  return rooms.get(id);
}

// ---------- นิสัยและกติกาของมิจิ ----------
const PERSONA = `คุณคือ "มิจิ" หนูตัวเล็กผู้หญิง เป็นสมาชิกคนหนึ่งในกลุ่มแชท ไม่ใช่ผู้ช่วยหรือพนักงานบริการ

วิธีพูด:
- พิมพ์แบบเพื่อนคุยกันในไลน์ สั้น เป็นกันเอง ใช้ภาษาพูดธรรมชาติ (นะ เนอะ อ่ะ เหรอ) ลงท้าย ค่ะ/คะ บ้างพอเป็นนิสัย ไม่ต้องลงท้ายทุกประโยค
- ตอบตรงคำถามก่อนเลย ไม่ทวนคำถาม ไม่เกริ่น ไม่สรุปปิดท้าย ส่วนใหญ่ 1-2 ประโยค ถ้าต้องอธิบายจริง ๆ ค่อยยาวขึ้น
- ปกติไม่ใช้อีโมจิ ใช้ได้นาน ๆ ครั้งและไม่เกิน 1 ตัว
- ห้ามใช้คำแบบพนักงานบริการหรือจดหมายสมัครงาน เช่น รับทราบ, ยินดีที่ได้รู้จัก, ฝากเนื้อฝากตัว, มีอะไรให้ช่วยไหม, ยินดีให้บริการ, ขอบคุณที่แจ้ง, ไม่ต้องกังวลนะคะ
- ไม่ต้องถามกลับทุกครั้ง ถามเมื่ออยากรู้จริง ๆ หรือจำเป็นต้องรู้เพื่อช่วย
- ไม่ต้องเรียกชื่อคนทุกประโยค นาน ๆ ครั้งตอนที่เป็นธรรมชาติ ไม่พูดซ้ำสิ่งที่ตัวเองเพิ่งพูด ไม่ประจบ ไม่ชมเกินจริง
- ถ้าไม่รู้ก็บอกว่าไม่รู้ตรง ๆ ไม่แต่งเรื่อง ถ้าเห็นต่างก็บอกตรง ๆ ได้อย่างนุ่มนวล
- จับน้ำเสียงคนที่คุยด้วย ถ้าเขาเล่นมิจิก็เล่นด้วย ถ้าเขาจริงจังหรือเศร้า มิจิจริงใจและเบา ๆ ไม่ปลอบเว่อร์
- ถามความรู้หรือให้ช่วยคิดเรื่องทั่วไป ตอบได้เหมือนเพื่อนที่เก่ง ใช้ภาษาเดียวกับที่เขาพิมพ์

ตัวตน:
- มิจิเป็นหนูตัวเล็กประจำกลุ่ม พูดเหมือนคนในกลุ่ม ไม่พูดถึงเรื่อง AI โมเดล หรือระบบเอง
- ห้ามอ้างว่าเป็นมนุษย์ ถ้ามีคนถามจริงจังว่าเป็นคนหรือบอทหรือ AI ให้ตอบตรง ๆ ว่ามิจิเป็นบอท

เรื่องที่มิจิไม่ยุ่ง:
- เรื่องเพศ อนาจาร ลามก การล่วงละเมิดหรือคุกคามทางเพศ ไม่ว่าจะเป็นข้อความ รูป หรือเสียง มิจิไม่คุยด้วยและไม่บรรยายรายละเอียด ปฏิเสธสั้น ๆ ไม่เทศน์ เช่น "อันนี้มิจิไม่คุยนะ" แล้วเปลี่ยนเรื่องหรือเงียบ
- ความรุนแรงจัดหรือสิ่งที่ทำให้ใครได้รับอันตราย ไม่ให้ข้อมูลที่ช่วยทำร้ายใคร ถ้าใครดูทุกข์จริง ๆ ให้ฟังอย่างใจดีและชวนหาคนใกล้ตัวหรือผู้เชี่ยวชาญ
- ไม่วินิจฉัยหรือตัดสินสุขภาพจิตหรือโรคของใคร และไม่เอาเรื่องส่วนตัวของคนหนึ่งไปบอกอีกคน

ตัวอย่างโทน (ห้ามลอกคำ ให้ตอบตามสถานการณ์จริง):
- ถามวัน/เวลา → ดูจากวันที่ที่ให้ไว้ แล้วตอบสั้น ๆ ตรงตามจริง
- ถามว่ารู้จักใครไหม ที่ไม่รู้จัก → "ไม่รู้จักอ่ะ ใครเหรอ"
- ให้แนะนำตัว → "มิจิ หนูประจำกลุ่มนี้ ชอบนั่งฟังทุกคนคุยกัน"
- ถูกทัก "ทำไมไม่ตอบ" → "อ้าว ตอบแล้วนะ"

ถ้ามิจิไม่ควรพูดในตอนนี้ (เขาคุยกับคนอื่นอยู่ หรือไม่เกี่ยวกับมิจิ) ให้ตอบคำเดียวว่า SKIP
ตอบเฉพาะข้อความที่มิจิจะพิมพ์เท่านั้น ห้ามขึ้นต้นด้วยชื่อ เช่น "มิจิ:"`;

function nowThai() {
  try {
    return new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'full', timeStyle: 'short' });
  } catch {
    return new Date().toISOString();
  }
}

// ---------- Gemini ----------
let preferredModel = null; // โมเดลข้อความที่เคยใช้ได้ล่าสุด
let preferredMedia = null; // โมเดลรูป/เสียงที่เคยใช้ได้ล่าสุด
const discovered = {};

const apiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

async function listModels() {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GEMINI_API_KEY}`,
    { signal: AbortSignal.timeout(TEXT_TIMEOUT_MS) }
  );
  const body = await res.text();
  if (!res.ok) throw new Error(`listModels ${res.status}: ${body.slice(0, 300)}`);
  return (JSON.parse(body).models || [])
    .filter((m) => m.name && (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}

async function discoverModel(needGemini) {
  const key = needGemini ? 'media' : 'text';
  if (discovered[key] && Date.now() - discovered[key].ts < 10 * 60 * 1000) return discovered[key].name;
  const names = await listModels();
  const pick = needGemini
    ? names.find((n) => /^gemini-.*flash-lite/.test(n) && !/(preview|exp|tts|image)/.test(n)) ||
      names.find((n) => /^gemini-.*flash/.test(n) && !/(preview|exp|tts|image)/.test(n)) ||
      null
    : names.find((n) => /^gemini-.*flash-lite/.test(n) && !/(preview|exp|tts|image)/.test(n)) ||
      names.find((n) => /^gemma-3-.*-it$/.test(n)) ||
      names.find((n) => /^gemini-.*flash/.test(n) && !/(preview|exp|tts|image)/.test(n)) ||
      null;
  discovered[key] = { ts: Date.now(), name: pick };
  if (pick) trace(`ค้นหาโมเดลอัตโนมัติ (${key}): เจอ ${pick}`);
  return pick;
}

async function callModel(model, prompt, media) {
  const parts = [{ text: prompt }];
  if (media) parts.push({ inlineData: { mimeType: media.mime, data: media.data } });
  const res = await fetch(apiUrl(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
    }),
    signal: AbortSignal.timeout(media ? MEDIA_TIMEOUT_MS : TEXT_TIMEOUT_MS),
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

// เก็บอีโมจิไว้ไม่เกิน 1 ตัว และนาน ๆ ครั้งเท่านั้น
function trimEmoji(t) {
  let n = 0;
  const keep = Math.random() < 0.15;
  return t
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, (m) => (keep && n++ === 0 ? m : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.!?ๆ])/g, '$1')
    .trim();
}

function cleanReply(t) {
  return trimEmoji(
    t
      .replace(/^\s*(มิจิ|miji)\s*[:：]\s*/i, '')
      .replace(/^["“'‘]+|["”'’]+$/g, '')
      .trim()
  ).slice(0, 800);
}

async function askGemini(room, speaker, reason, forced = false, media = null) {
  const chat = room.history.map((h) => `${h.name}: ${h.text}`).join('\n');
  const members = [...new Set(room.members.values())].join(', ');
  const mediaNote = media
    ? `\nแนบ${media.type === 'audio' ? 'ไฟล์เสียง' : 'รูปภาพ'}มาให้ดู/ฟังด้วย ที่ ${media.ownerName} ส่งมาในกลุ่ม ตอบตามที่ ${speaker} ถามหรือพูดถึงสิ่งที่แนบมา${
        media.type === 'audio' ? ' ถ้าถามว่าเขาพูดอะไร ให้เล่าสั้น ๆ ว่าเสียงนั้นพูดว่าอะไร' : ''
      }\nถ้าสื่อที่แนบเป็นเรื่องเพศ/ลามก/อนาจาร/ความรุนแรงจัด ห้ามบรรยายรายละเอียด ให้ปฏิเสธสั้น ๆ`
    : '';
  const prompt = `${PERSONA}

ตอนนี้: ${nowThai()} (เวลาไทย)
สมาชิกที่มิจิรู้จักในกลุ่ม: ${members}
คนที่เพิ่งพิมพ์ข้อความล่าสุด: ${speaker}
สถานการณ์: ${reason}${mediaNote}

แชทล่าสุด:
${chat}

${forced ? 'ข้อความนี้พูดกับมิจิแน่นอน ห้ามตอบ SKIP ให้ตอบเหมือนคนคุยกันทั่วไป' : 'ถ้าไม่แน่ใจว่าพูดกับใคร ให้เอนไปทางตอบ ถ้าชัดเจนว่าพูดกับคนอื่นให้ SKIP'}
มิจิควรตอบอะไร?`;

  const list = (s) => s.split(',').map((m) => m.trim());
  const models = [
    ...new Set(
      (media
        ? [preferredMedia, MEDIA_MODEL, 'gemini-flash-latest']
        : [preferredModel, GEMINI_MODEL, ...list(FALLBACK_MODELS)]
      ).filter(Boolean)
    ),
  ].slice(0, media ? 2 : 3);

  let lastErr;
  let sawNotFound = false;
  const tryModel = async (model) => {
    try {
      const r = await callModel(model, prompt, media);
      if (media) preferredMedia = model;
      else preferredModel = model;
      return r;
    } catch (e) {
      lastErr = e;
      if (e.status === 404 || e.status === 400) sawNotFound = true;
      logError('gemini', e.name === 'TimeoutError' ? `${model} timeout` : e);
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
      const m = await discoverModel(!!media);
      if (m && !models.includes(m)) result = await tryModel(m);
    } catch (e) {
      logError('discover', e);
    }
  }
  if (!result) throw lastErr || new Error('Gemini ไม่ตอบ');

  let out = cleanReply(result.text);
  if (!out && /SAFETY|PROHIBITED|BLOCK/i.test(result.reason)) {
    out = media ? 'อันนี้มิจิไม่ดูนะ' : 'อันนี้มิจิไม่คุยนะ'; // โดนตัวกรองความปลอดภัย = ปฏิเสธแบบมิจิ
    trace(`ถูกตัวกรองความปลอดภัยบล็อก (${result.reason}) → ปฏิเสธสั้น ๆ`);
  }
  if (forced && (!out || out.toUpperCase().startsWith('SKIP'))) {
    logError('empty-reply', `AI ตอบว่าง/SKIP ทั้งที่ถูกเรียกตรง ๆ (finishReason: ${result.reason})`);
  }
  return out;
}

// ---------- ดึงรูป/เสียงจาก LINE ----------
async function fetchMedia(entry) {
  const url = `https://api-data.line.me/v2/bot/message/${entry.id}/content`;
  let res;
  for (let i = 0; i < 3; i++) {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status !== 202) break; // 202 = LINE ยังเตรียมไฟล์อยู่
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!res.ok) throw new Error(`โหลดไฟล์จาก LINE ไม่ได้ (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MEDIA_MAX_BYTES) throw new Error(`ไฟล์ใหญ่เกิน ${MEDIA_MAX_BYTES / 1024 / 1024}MB`);
  let mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (entry.type === 'audio') mime = 'audio/mp4'; // เสียงของ LINE เป็น m4a
  else if (!mime.startsWith('image/')) mime = 'image/jpeg';
  return { type: entry.type, mime, data: buf.toString('base64'), ownerName: entry.name };
}

function pickMedia(room, event, userId, text) {
  const q = event.message.quotedMessageId;
  if (q) {
    const m = room.media.find((x) => x.id === q);
    if (m) return m; // กด Reply รูป/เสียงนั้นมา
  }
  if (!MEDIA_HINT.test(text)) return null;
  const now = Date.now();
  const recent = [...room.media].reverse();
  return (
    recent.find((x) => x.userId === userId && now - x.ts < 3 * 60000) ||
    recent.find((x) => now - x.ts < 5 * 60000) ||
    null
  );
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
  if (userId) room.active.set(userId, { ts: Date.now(), forced });
}

const isSkip = (r) => !r || r.toUpperCase().startsWith('SKIP');
const mediaLabel = (t) => (t === 'audio' ? 'เสียง' : 'รูป');

async function prepare(event) {
  if (event.webhookEventId) {
    if (seenEvents.has(event.webhookEventId)) return null; // กันส่งซ้ำ
    seenEvents.add(event.webhookEventId);
    if (seenEvents.size > 1000) seenEvents.clear();
  }
  const userId = event.source.userId;
  const roomId = event.source.groupId || event.source.roomId || userId;
  const room = getRoom(roomId);
  if (userId && !room.members.has(userId)) room.members.set(userId, await fetchName(event));
  const name = room.members.get(userId) || 'สมาชิก';
  const act = room.active.get(userId);
  return {
    userId,
    room,
    name,
    act,
    isActive: !!act && Date.now() - act.ts < ACTIVE_MS,
    isPrivate: event.source.type === 'user',
  };
}

// รูป/เสียง: จำไว้ก่อน (ไม่เสียโควต้า) แล้วค่อยดูเมื่อมีคนถามหรือคุยกับมิจิอยู่
async function handleMedia(event) {
  const c = await prepare(event);
  if (!c) return;
  const { userId, room, name, act, isActive, isPrivate } = c;
  const type = event.message.type;
  room.media.push({ id: event.message.id, type, userId, name, ts: Date.now() });
  if (room.media.length > 10) room.media.shift();
  room.history.push({ name, text: type === 'audio' ? '[ส่งข้อความเสียง]' : '[ส่งรูปภาพ]' });
  if (room.history.length > HISTORY_MAX) room.history.shift();
  room.count++;
  if (!isPrivate && !isActive) return;

  const who = `${name}${isPrivate ? ' (แชทส่วนตัว)' : ''}`;
  try {
    const media = await fetchMedia(room.media[room.media.length - 1]);
    const reply = await askGemini(room, name, `${name} ส่ง${mediaLabel(type)}มาให้มิจิดู/ฟัง`, isPrivate || !!act?.forced, media);
    if (isSkip(reply)) return trace(`${who}: ส่ง${mediaLabel(type)}มา แต่ AI ไม่ตอบ`);
    await send(event, room, userId, reply, false);
    trace(`${who}: ส่ง${mediaLabel(type)}มา → ตอบแล้ว (${reply.length} ตัวอักษร)`);
  } catch (e) {
    logError('media', e);
  }
}

async function handleText(event) {
  const c = await prepare(event);
  if (!c) return;
  const { userId, room, name, act, isActive, isPrivate } = c;
  const text = event.message.text;

  room.history.push({ name, text });
  if (room.history.length > HISTORY_MAX) room.history.shift();
  room.count++;

  const lower = text.toLowerCase();
  const mentionees = event.message.mention?.mentionees || [];
  const mentioned = mentionees.some((m) => m.isSelf);
  const mentionsOther = mentionees.some((m) => !m.isSelf);
  const called = hasName(lower);
  const quotedBot = !!event.message.quotedMessageId && botMsgIds.has(event.message.quotedMessageId);
  const who = `${name}${isPrivate ? ' (แชทส่วนตัว)' : ''}`;

  // เตรียมคำตอบ โดยแนบรูป/เสียงถ้ามีคนพูดถึง
  const answer = async (reason, forced) => {
    const entry = pickMedia(room, event, userId, text);
    let media = null;
    if (entry) {
      try {
        media = await fetchMedia(entry);
      } catch (e) {
        logError('media', e);
        return null;
      }
    }
    return askGemini(room, name, entry ? `${reason} (พูดถึง${mediaLabel(entry.type)}ที่ ${entry.name} ส่งมา)` : reason, forced, media);
  };

  try {
    // 1) ถูกเรียกชื่อ/แท็ก/กด Reply/แชทส่วนตัว
    if (isPrivate || mentioned || called || quotedBot) {
      let rest = lower;
      BOT_NAMES.forEach((n) => (rest = rest.split(n).join('')));
      rest = rest.replace(/(น้อง|หนู)/g, '').replace(/[\s!?.,~ๆ@]+/g, '');
      if ((called || mentioned) && rest.length <= 2) {
        const ack = ACKS[Math.floor(Math.random() * ACKS.length)];
        await send(event, room, userId, ack, true); // ทักสั้น ๆ แล้วรอฟังประโยคถัดไป
        return trace(`${who}: เรียกชื่อ → ทัก "${ack}" แล้วรอฟัง`);
      }
      const reply = await answer(`${name} กำลังคุยกับมิจิโดยตรง`, true);
      if (isSkip(reply)) return trace(`${who}: คุยตรง แต่ไม่มีคำตอบ`);
      await send(event, room, userId, reply, false);
      return trace(`${who}: คุยตรง → ตอบแล้ว (${reply.length} ตัวอักษร)`);
    }

    // 2) คนที่เพิ่งคุยกับมิจิ (ยังไม่เกิน 5 นาที)
    if (isActive) {
      const forced = act.forced && !mentionsOther;
      const reply = await answer(`${name} เพิ่งคุยกับมิจิเมื่อไม่นานนี้ ข้อความล่าสุดน่าจะคุยต่อกับมิจิ`, forced);
      if (isSkip(reply)) return trace(`${who}: กำลังคุยอยู่ แต่ไม่ได้คุยกับมิจิ`);
      await send(event, room, userId, reply, false);
      return trace(`${who}: คุยต่อ → ตอบแล้ว (${reply.length} ตัวอักษร)`);
    }

    // 3) คำหยาบ / เช็กบรรยากาศเป็นระยะ
    if (Date.now() - room.lastReply < COOLDOWN_MS) return;
    const harsh = HARSH.some((w) => lower.includes(w));
    const periodic = room.count % CHECK_EVERY === 0;
    if (!harsh && !periodic) return;
    const reply = await askGemini(
      room,
      name,
      harsh ? 'มีคำหยาบ/บรรยากาศเริ่มตึง ช่วยทำให้กลุ่มสงบอย่างอ่อนโยน' : 'เช็กบรรยากาศ พูดเฉพาะถ้าควรจริง ๆ ไม่งั้น SKIP'
    );
    if (isSkip(reply)) return trace(`${who}: ${harsh ? 'คำหยาบ' : 'เช็กบรรยากาศ'} → เลือกเงียบ`);
    await send(event, room, null, reply);
    trace(`${who}: ${harsh ? 'คำหยาบ' : 'เช็กบรรยากาศ'} → แทรกตอบแล้ว`);
  } catch (e) {
    logError('handleEvent', e); // เงียบในไลน์ ส่ง error ไปที่หน้าเว็บแทน
  }
}

async function handleSticker(event) {
  const c = await prepare(event);
  if (!c) return;
  const kw = (event.message.keywords || []).slice(0, 3).join(', ');
  c.room.history.push({ name: c.name, text: `[ส่งสติกเกอร์${kw ? ': ' + kw : ''}]` });
  if (c.room.history.length > HISTORY_MAX) c.room.history.shift();
  c.room.count++;
}

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const t = event.message.type;
  if (t === 'text') return handleText(event);
  if (t === 'image' || t === 'audio') return handleMedia(event);
  if (t === 'sticker') return handleSticker(event);
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
  const q = String(req.query.q || 'วันนี้วันอะไร');
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
    res.send(page('models', `<h3>โมเดลที่คีย์นี้เรียกได้ (${names.length})</h3><p>ข้อความ: ${esc(GEMINI_MODEL)} / รูป-เสียง: ${esc(MEDIA_MODEL)}</p><ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`));
  } catch (e) {
    res.status(500).send(page('models', `<p>❌ ${esc(e.message)}</p>`));
  }
});

app.post('/webhook', line.middleware({ channelSecret: LINE_CHANNEL_SECRET }), (req, res) => {
  res.sendStatus(200); // ตอบ LINE ทันที แล้วค่อยประมวลผล กัน timeout
  for (const ev of req.body.events || []) handleEvent(ev).catch((e) => logError('handleEvent', e));
});

app.use((err, req, res, next) => {
  logError('webhook', err);
  res.status(err instanceof line.SignatureValidationFailed ? 401 : err.statusCode || 500).send('error');
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Miji listening on ${PORT}`));
}
module.exports = { app, logs };
