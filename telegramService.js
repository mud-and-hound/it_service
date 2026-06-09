// telegramService.js — Telegram Bot Notification Service
// ส่งแบบเดียวกับ LINE แต่ไม่มี Quota limit
// รองรับ !groupid command สำหรับหา Chat ID ของแต่ละกลุ่ม

const axios = require('axios');

// ── Token & Chat IDs (จาก Render Environment) ─────────────────
function getToken() { return process.env.TELEGRAM_BOT_TOKEN || ''; }
function getTgApi() { return `https://api.telegram.org/bot${getToken()}`; }

// ── Brand Chat IDs ────────────────────────────────────────────
function getChatIds() {
  return {
    // Admin Groups (รับ: งานใหม่ + รอตรวจ + จบงาน)
    admin: {
      "Dunkin'"            : process.env.TELEGRAM_ADMIN_GD  || process.env.TELEGRAM_ADMIN_CHAT_ID || '',
      "Greyhound Cafe'"    : process.env.TELEGRAM_ADMIN_GHC || process.env.TELEGRAM_ADMIN_CHAT_ID || '',
      "Greyhound Original" : process.env.TELEGRAM_ADMIN_GH  || process.env.TELEGRAM_ADMIN_CHAT_ID || '',
      "Au Bon Pain"        : process.env.TELEGRAM_ADMIN_ABP || process.env.TELEGRAM_ADMIN_CHAT_ID || '',
      "Funky Fries"        : process.env.TELEGRAM_ADMIN_FF  || process.env.TELEGRAM_ADMIN_CHAT_ID || '',
      "Another Hound Cafe'": process.env.TELEGRAM_ADMIN_AHC || process.env.TELEGRAM_ADMIN_CHAT_ID || '',
      "Bean Hound"         : process.env.TELEGRAM_ADMIN_BE  || process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    },
    // Brand Groups (รับ: งานใหม่ + จบงาน เท่านั้น)
    brand: {
      "Dunkin'"            : process.env.TELEGRAM_CHAT_GD  || '',
      "Greyhound Cafe'"    : process.env.TELEGRAM_CHAT_GHC || '',
      "Greyhound Original" : process.env.TELEGRAM_CHAT_GH  || '',
      "Au Bon Pain"        : process.env.TELEGRAM_CHAT_ABP || '',
      "Funky Fries"        : process.env.TELEGRAM_CHAT_FF  || '',
      "Another Hound Cafe'": process.env.TELEGRAM_CHAT_AHC || '',
      "Bean Hound"         : process.env.TELEGRAM_CHAT_BE  || '',
    },
    // Engineer Groups (รับ: มอบหมาย + โอนงาน + แก้ไข)
    engineer: {
      "Dunkin'"            : process.env.TELEGRAM_ENG_GD  || '',
      "Greyhound Cafe'"    : process.env.TELEGRAM_ENG_GHC || '',
      "Greyhound Original" : process.env.TELEGRAM_ENG_GH  || '',
      "Au Bon Pain"        : process.env.TELEGRAM_ENG_ABP || '',
      "Funky Fries"        : process.env.TELEGRAM_ENG_FF  || '',
      "Another Hound Cafe'": process.env.TELEGRAM_ENG_AHC || '',
      "Bean Hound"         : process.env.TELEGRAM_ENG_BE  || '',
    },
  };
}

// ── ส่ง message ──────────────────────────────────────────────
async function sendMessage(chatId, text, options = {}) {
  const token = getToken();
  if (!token) { console.warn('[TG] No TELEGRAM_BOT_TOKEN'); return { ok:false, error:'no token' }; }
  if (!chatId){ console.warn('[TG] No chatId'); return { ok:false, error:'no chatId' }; }
  try {
    const r = await axios.post(`${getTgApi()}/sendMessage`, {
      chat_id: chatId, text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...options,
    }, { timeout: 10_000 });
    console.log(`[TG] sent to ${String(chatId).slice(0,10)}...`);
    return { ok:true, message_id: r.data?.result?.message_id };
  } catch (e) {
    const err = e.response?.data?.description || e.message;
    console.error('[TG sendMessage]', err);
    return { ok:false, error: err };
  }
}

// ── ส่งหลาย Chat ID พร้อมกัน (dedup) ─────────────────────────
async function sendToMany(chatIds, text) {
  const unique = [...new Set(chatIds.filter(Boolean))];
  return Promise.all(unique.map(id => sendMessage(id, text)));
}

// ── Message Builders ──────────────────────────────────────────
function brandEmoji(brand = '') {
  const m = { "Dunkin'":'🍩',"Greyhound Cafe'":'🐕',"Greyhound Original":'🐕',"Au Bon Pain":'🥐',"Funky Fries":'🍟',"Another Hound Cafe'":'🐾',"Bean Hound":'☕' };
  return m[brand] || '🏪';
}

function formatDateTime() {
  return new Date().toLocaleString('th-TH', { timeZone:'Asia/Bangkok', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function buildNewTicketMsg(t) {
  return [
    `🎫 <b>Ticket ใหม่ | ${t.id||'-'}</b>`,``,
    `${brandEmoji(t.brand)} <b>แบรนด์:</b> ${t.brand||'-'}`,
    `🏪 <b>สาขา:</b> ${t.branchCode||'-'}`,
    `📋 <b>ประเภท:</b> ${t.type||'-'}`,
    `📝 <b>รายละเอียด:</b> ${(t.detail||'-').slice(0,150)}`,
    `👤 <b>ผู้แจ้ง:</b> ${t.reporter||'-'}`,
    `📞 <b>เบอร์:</b> ${t.phone||'-'}`,
    `⏱️ <b>สถานะ:</b> รอดำเนินการ`,``,
    `🕐 <b>เวลา:</b> ${formatDateTime()}`,``,
    `👉 <a href="https://it-service-56im.onrender.com/admin">เปิด Admin Dashboard</a>`,
  ].join('\n');
}

function buildAssignedMsg(t) {
  return [
    `🔔 <b>มีงานมอบหมายให้กลุ่มนี้</b>`,``,
    `🎫 <b>Ticket:</b> ${t.id||'-'}`,
    `${brandEmoji(t.brand)} <b>แบรนด์:</b> ${t.brand||'-'}`,
    `🏪 <b>สาขา:</b> ${t.branchCode||'-'}`,
    `📋 <b>ประเภท:</b> ${t.type||'-'}`,
    `📝 <b>รายละเอียด:</b> ${(t.detail||'-').slice(0,150)}`,
    `👤 <b>มอบหมายให้:</b> ${t.engineerName||'-'}`,``,
    `🕐 <b>เวลา:</b> ${formatDateTime()}`,``,
    `👉 <a href="https://it-service-56im.onrender.com/engineer">เปิดหน้าช่าง</a>`,
  ].join('\n');
}

function buildWorkSubmittedMsg(t) {
  return [
    `🔧 <b>ช่างส่งงานแล้ว — รอตรวจ | ${t.id||'-'}</b>`,``,
    `👤 <b>ช่าง:</b> ${t.engineerName||'-'}`,
    `${brandEmoji(t.brand)} <b>แบรนด์:</b> ${t.brand||'-'}`,
    `🏪 <b>สาขา:</b> ${t.branchCode||'-'}`,
    `📋 <b>รายละเอียดงาน:</b> ${(t.workDetail||'-').slice(0,150)}`,
    `🔩 <b>อะไหล่:</b> ${t.partsUsed||'-'}`,
    `⏱️ <b>ชั่วโมงงาน:</b> ${t.workHours||'-'}`,``,
    `🕐 <b>เวลา:</b> ${formatDateTime()}`,``,
    `👉 <a href="https://it-service-56im.onrender.com/admin">ตรวจรับงาน</a>`,
  ].join('\n');
}

function buildClosedMsg(t) {
  return [
    `✅ <b>ปิดงานแล้ว | ${t.id||'-'}</b>`,``,
    `${brandEmoji(t.brand)} <b>แบรนด์:</b> ${t.brand||'-'}`,
    `🏪 <b>สาขา:</b> ${t.branchCode||'-'}`,
    `📋 <b>ประเภท:</b> ${t.type||'-'}`,
    `👤 <b>ช่าง:</b> ${t.engineerName||'-'}`,
    `📝 <b>หมายเหตุ:</b> ${(t.adminNote||'-').slice(0,100)}`,``,
    `🕐 <b>ปิดเมื่อ:</b> ${formatDateTime()}`,
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════
// Notification Functions — ส่งถูกกลุ่มตาม Event Type
// ══════════════════════════════════════════════════════════════

// 1. งานใหม่ → Brand Group + Admin Group (ของแบรนด์นั้น)
async function notifyNewTicket(ticket) {
  const ids = getChatIds();
  const brand = ticket.brand || '';
  const targets = [
    ids.brand[brand],   // Brand Group
    ids.admin[brand],   // Admin Group ของแบรนด์นั้น
  ];
  return sendToMany(targets, buildNewTicketMsg(ticket));
}

// 2. มอบหมายช่าง → Engineer Group (ของแบรนด์นั้น)
async function notifyAssigned(ticket, engineerLineId, engineerTelegramId) {
  const ids = getChatIds();
  const brand = ticket.brand || '';
  const targets = [ids.engineer[brand]];
  // ถ้ามี Telegram ID ส่วนตัวของช่างด้วย
  if (engineerTelegramId) targets.push(engineerTelegramId);
  return sendToMany(targets, buildAssignedMsg(ticket));
}

// 3. ช่างส่งงาน → Admin Group (ของแบรนด์นั้น) เท่านั้น
async function notifyWorkSubmitted(ticket) {
  const ids = getChatIds();
  const brand = ticket.brand || '';
  const targets = [ids.admin[brand]];
  return sendToMany(targets, buildWorkSubmittedMsg(ticket));
}

// 4. ปิดงาน → Brand Group + Admin Group (ของแบรนด์นั้น)
async function notifyTicketClosed(ticket) {
  const ids = getChatIds();
  const brand = ticket.brand || '';
  const targets = [
    ids.brand[brand],   // Brand Group
    ids.admin[brand],   // Admin Group
  ];
  return sendToMany(targets, buildClosedMsg(ticket));
}

// 5. แก้ไขงาน → Engineer Group (ของแบรนด์นั้น)
async function notifyRevision(ticket, engineerLineId, engineerTelegramId) {
  const ids = getChatIds();
  const brand = ticket.brand || '';
  const targets = [ids.engineer[brand]];
  if (engineerTelegramId) targets.push(engineerTelegramId);
  const msg = `✏️ <b>Ticket ${ticket.id||'-'} มีการแก้ไข</b>\nกรุณาตรวจสอบและดำเนินการต่อ`;
  return sendToMany(targets, msg);
}

// 6. โอนงาน → Engineer Group (ของแบรนด์นั้น)
async function notifyReassigned(ticket, oldEngLineId, newEngLineId, oldEngTgId, newEngTgId) {
  const ids = getChatIds();
  const brand = ticket.brand || '';
  const targets = [ids.engineer[brand]];
  const msg = [
    `🔄 <b>โอนงาน | ${ticket.id||'-'}</b>`,``,
    `${brandEmoji(brand)} <b>แบรนด์:</b> ${brand||'-'}`,
    `👤 <b>ช่างใหม่:</b> ${ticket.engineerName||'-'}`,``,
    `🕐 <b>เวลา:</b> ${formatDateTime()}`,
  ].join('\n');
  return sendToMany(targets, msg);
}

// ── ตรวจสอบ Bot Status ────────────────────────────────────────
async function checkBotStatus() {
  const token = getToken();
  if (!token) return { ok:false, error:'no token', botName:null };
  try {
    const r = await axios.get(`${getTgApi()}/getMe`, { timeout:5000 });
    return { ok: r.data?.ok||false, botName: r.data?.result?.username||null, botId: r.data?.result?.id||null };
  } catch (e) {
    return { ok:false, error:e.message, botName:null };
  }
}

// ══════════════════════════════════════════════════════════════
// !groupid Webhook Handler
// พิมพ์ !groupid ในกลุ่มใดก็ได้ → Bot ตอบ Chat ID ทันที
// ══════════════════════════════════════════════════════════════
async function handleWebhook(update) {
  try {
    const msg = update?.message || update?.channel_post;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const text   = (msg.text || '').trim().toLowerCase();
    const title  = msg.chat?.title || msg.chat?.first_name || 'this chat';

    if (text === '!groupid' || text === '!groupid@itsupporthub_bot') {
      const token = getToken();
      // แสดง Token แค่บางส่วน เช่น 8897916791:AAGUC***
      const colonIdx = token.indexOf(':');
      const tokenPreview = colonIdx > 0
        ? token.slice(0, colonIdx + 6) + '***'
        : '(not set)';

      const reply = [
        `ℹ️ <b>Group ID Info</b>`,``,
        `📛 <b>ชื่อกลุ่ม:</b> ${title}`,
        `🆔 <b>Chat ID:</b> <code>${chatId}</code>`,``,
        `━━━━━━━━━━━━━━━━━━━`,
        `📋 <b>ใส่ใน Render Environment:</b>`,``,
        `<code>TELEGRAM_ADMIN_CHAT_ID = ${chatId}</code>`,``,
        `🤖 <b>Bot Token (บางส่วน):</b>`,
        `<code>${tokenPreview}</code>`,``,
        `💡 Token เต็มดูได้ใน Render Dashboard`,
      ].join('\n');

      await sendMessage(chatId, reply);
      console.log(`[TG] !groupid → chat ${chatId} (${title})`);
    }
  } catch (e) {
    console.error('[TG handleWebhook]', e.message);
  }
}

module.exports = {
  sendMessage,
  sendToMany,
  notifyNewTicket,
  notifyAssigned,
  notifyWorkSubmitted,
  notifyTicketClosed,
  notifyRevision,
  notifyReassigned,
  checkBotStatus,
  handleWebhook,
  getChatIds,
};
