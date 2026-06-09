// telegramService.js — Telegram Bot Notification Service
// ส่งแบบเดียวกับ LINE แต่ไม่มี Quota limit
// ทุก event ที่ LINE ส่ง → Telegram ส่งด้วยเสมอ

const axios = require('axios');

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_ADMIN_CHAT = process.env.TELEGRAM_ADMIN_CHAT_ID || ''; // Group/Channel ID

// Brand Chat IDs (optional - ถ้าต้องการแยก Group ตาม Brand เหมือน LINE)
const BRAND_CHAT_MAP = {
  "Dunkin'"            : process.env.TELEGRAM_CHAT_DUNKIN   || '',
  "Greyhound Cafe"     : process.env.TELEGRAM_CHAT_GHC      || '',
  "Greyhound Original" : process.env.TELEGRAM_CHAT_GH       || '',
  "Au Bon Pain"        : process.env.TELEGRAM_CHAT_ABP      || '',
  "Funky Fries"        : process.env.TELEGRAM_CHAT_FF       || '',
};

const TG_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

// ── ส่ง message ──────────────────────────────────────────────
async function sendMessage(chatId, text, options = {}) {
  if (!TG_BOT_TOKEN) {
    console.warn('[TG] No TELEGRAM_BOT_TOKEN set — skip');
    return { ok: false, error: 'no token' };
  }
  if (!chatId) {
    console.warn('[TG] No chatId — skip');
    return { ok: false, error: 'no chatId' };
  }
  try {
    const r = await axios.post(`${TG_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...options,
    }, { timeout: 10_000 });
    console.log(`[TG] sent to ${String(chatId).slice(0, 10)}...`);
    return { ok: true, message_id: r.data?.result?.message_id };
  } catch (e) {
    const err = e.response?.data?.description || e.message;
    console.error('[TG sendMessage]', err);
    return { ok: false, error: err };
  }
}

// ── ดึง Brand Chat ID ─────────────────────────────────────────
function getBrandChatId(brand) {
  return BRAND_CHAT_MAP[brand] || '';
}

// ── Format: ตรงกับ Event ของ LINE ────────────────────────────

// 1. Ticket ใหม่ → แจ้ง Admin Group + Brand Group
async function notifyNewTicket(ticket) {
  const msg = buildNewTicketMsg(ticket);
  const results = [];

  // Admin Group
  if (TG_ADMIN_CHAT) {
    results.push(await sendMessage(TG_ADMIN_CHAT, msg));
  }

  // Brand Group (ถ้ามี config)
  const brandChat = getBrandChatId(ticket.brand);
  if (brandChat && brandChat !== TG_ADMIN_CHAT) {
    results.push(await sendMessage(brandChat, msg));
  }

  return results;
}

// 2. มอบหมายช่าง → แจ้ง Telegram ส่วนตัวช่าง
async function notifyAssigned(ticket, engineerTelegramId) {
  if (!engineerTelegramId) return { ok: false, error: 'no engineer telegram id' };
  const msg = buildAssignedMsg(ticket);
  return sendMessage(engineerTelegramId, msg);
}

// 3. ช่างส่งงาน → แจ้ง Admin Group
async function notifyWorkSubmitted(ticket) {
  const msg = buildWorkSubmittedMsg(ticket);
  const results = [];
  if (TG_ADMIN_CHAT) results.push(await sendMessage(TG_ADMIN_CHAT, msg));
  const brandChat = getBrandChatId(ticket.brand);
  if (brandChat && brandChat !== TG_ADMIN_CHAT) results.push(await sendMessage(brandChat, msg));
  return results;
}

// 4. ปิด Ticket → แจ้ง Admin + Brand Group
async function notifyTicketClosed(ticket) {
  const msg = buildClosedMsg(ticket);
  const results = [];
  if (TG_ADMIN_CHAT) results.push(await sendMessage(TG_ADMIN_CHAT, msg));
  const brandChat = getBrandChatId(ticket.brand);
  if (brandChat && brandChat !== TG_ADMIN_CHAT) results.push(await sendMessage(brandChat, msg));
  return results;
}

// 5. แก้ไข Ticket
async function notifyRevision(ticket, engineerTelegramId) {
  if (!engineerTelegramId) return;
  const msg = `✏️ <b>Ticket ${ticket.id || '-'} มีการแก้ไข</b>\nกรุณาตรวจสอบและดำเนินการต่อ`;
  return sendMessage(engineerTelegramId, msg);
}

// 6. โอนงาน
async function notifyReassigned(ticket, oldEngTgId, newEngTgId) {
  const results = [];
  if (oldEngTgId) {
    results.push(await sendMessage(oldEngTgId,
      `🔄 <b>Ticket ${ticket.id || '-'} ถูกโอนให้ช่างคนอื่น</b>`
    ));
  }
  if (newEngTgId) {
    results.push(await notifyAssigned(ticket, newEngTgId));
  }
  return results;
}

// ── Message Builders ─────────────────────────────────────────

function brandEmoji(brand = '') {
  const map = {
    "Dunkin'"            : '🍩',
    "Greyhound Cafe"     : '🐕',
    "Greyhound Original" : '🐕',
    "Au Bon Pain"        : '🥐',
    "Funky Fries"        : '🍟',
  };
  return map[brand] || '🏪';
}

function statusEmoji(status = '') {
  if (status.includes('เสร็จสิ้น')) return '✅';
  if (status.includes('ระหว่าง'))  return '⚙️';
  if (status.includes('ตรวจ'))     return '🔍';
  if (status.includes('ยกเลิก'))   return '❌';
  return '⏱️';
}

function buildNewTicketMsg(t) {
  const emoji = brandEmoji(t.brand);
  return [
    `🎫 <b>Ticket ใหม่ | ${t.id || '-'}</b>`,
    ``,
    `${emoji} <b>แบรนด์:</b> ${t.brand || '-'}`,
    `🏪 <b>สาขา:</b> ${t.branchCode || '-'}`,
    `📋 <b>ประเภท:</b> ${t.type || '-'}`,
    `📝 <b>รายละเอียด:</b> ${(t.detail || '-').slice(0, 150)}`,
    `👤 <b>ผู้แจ้ง:</b> ${t.reporter || '-'}`,
    `📞 <b>เบอร์:</b> ${t.phone || '-'}`,
    `⏱️ <b>สถานะ:</b> รอดำเนินการ`,
    ``,
    `🕐 <b>เวลา:</b> ${formatDateTime()}`,
    ``,
    `👉 <a href="https://it-service-56im.onrender.com/admin">เปิด Admin Dashboard</a>`,
  ].join('\n');
}

function buildAssignedMsg(t) {
  const emoji = brandEmoji(t.brand);
  return [
    `🔔 <b>มีงานมอบหมายให้คุณ</b>`,
    ``,
    `🎫 <b>Ticket:</b> ${t.id || '-'}`,
    `${emoji} <b>แบรนด์:</b> ${t.brand || '-'}`,
    `🏪 <b>สาขา:</b> ${t.branchCode || '-'}`,
    `📋 <b>ประเภท:</b> ${t.type || '-'}`,
    `📝 <b>รายละเอียด:</b> ${(t.detail || '-').slice(0, 150)}`,
    ``,
    `🕐 <b>เวลา:</b> ${formatDateTime()}`,
    ``,
    `👉 <a href="https://it-service-56im.onrender.com/engineer">เปิดหน้าช่าง</a>`,
  ].join('\n');
}

function buildWorkSubmittedMsg(t) {
  return [
    `🔧 <b>ช่างส่งงานแล้ว | ${t.id || '-'}</b>`,
    ``,
    `👤 <b>ช่าง:</b> ${t.engineerName || '-'}`,
    `📋 <b>รายละเอียดงาน:</b> ${(t.workDetail || '-').slice(0, 150)}`,
    `🔩 <b>อะไหล่:</b> ${t.partsUsed || '-'}`,
    `⏱️ <b>ชั่วโมงงาน:</b> ${t.workHours || '-'}`,
    ``,
    `🕐 <b>เวลา:</b> ${formatDateTime()}`,
    ``,
    `👉 <a href="https://it-service-56im.onrender.com/admin">ตรวจรับงาน</a>`,
  ].join('\n');
}

function buildClosedMsg(t) {
  const emoji = brandEmoji(t.brand);
  return [
    `✅ <b>ปิดงานแล้ว | ${t.id || '-'}</b>`,
    ``,
    `${emoji} <b>แบรนด์:</b> ${t.brand || '-'}`,
    `🏪 <b>สาขา:</b> ${t.branchCode || '-'}`,
    `📋 <b>ประเภท:</b> ${t.type || '-'}`,
    `👤 <b>ช่าง:</b> ${t.engineerName || '-'}`,
    `📝 <b>หมายเหตุ Admin:</b> ${(t.adminNote || '-').slice(0, 100)}`,
    ``,
    `🕐 <b>ปิดเมื่อ:</b> ${formatDateTime()}`,
  ].join('\n');
}

function formatDateTime() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── ตรวจสอบ Bot Token ว่าใช้งานได้ ───────────────────────────
async function checkBotStatus() {
  if (!TG_BOT_TOKEN) return { ok: false, error: 'no token', botName: null };
  try {
    const r = await axios.get(`${TG_API}/getMe`, { timeout: 5000 });
    return {
      ok: r.data?.ok || false,
      botName: r.data?.result?.username || null,
      botId: r.data?.result?.id || null,
    };
  } catch (e) {
    return { ok: false, error: e.message, botName: null };
  }
}

module.exports = {
  sendMessage,
  notifyNewTicket,
  notifyAssigned,
  notifyWorkSubmitted,
  notifyTicketClosed,
  notifyRevision,
  notifyReassigned,
  checkBotStatus,
  getBrandChatId,
};
