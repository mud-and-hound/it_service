// notifyHub.js — Hybrid Notification Hub
// LINE OA + Telegram Bot
//
// Rules:
// 1. ส่ง LINE และ Telegram พร้อมกันทุก Event
// 2. LINE: ตรวจ Quota 300/เดือน ก่อนส่งทุกครั้ง
// 3. LINE เต็ม Quota → หยุดส่ง LINE แต่ Telegram ยังส่งปกติ
// 4. ส่งเฉพาะ Event ที่ submit วันนี้ (Real-Time Only)
// 5. ห้ามส่งซ้ำ (Duplicate Protection via notification_log)

const lineNotify = require('./lineNotify');
const telegram   = require('./telegramService');
const axios      = require('axios');

const REPAIR_URL = process.env.REPAIR_API_URL || 'https://repair.mobile1234.site';
const REPAIR_KEY = process.env.REPAIR_API_KEY  || 'repair123';
const REPAIR_HDR = { 'X-API-Key': REPAIR_KEY, 'Content-Type': 'application/json' };

// LINE Quota limit per month
const LINE_QUOTA_LIMIT = parseInt(process.env.LINE_QUOTA_LIMIT || '300');

// ── In-memory Quota cache (refresh ทุก 5 นาที) ───────────────
let _quotaCache = null;
let _quotaExp   = 0;

// ── ดึง LINE Quota Usage จาก MySQL ──────────────────────────
async function getLineQuotaUsage() {
  if (_quotaCache !== null && Date.now() < _quotaExp) {
    return _quotaCache;
  }
  try {
    const r = await axios.get(`${REPAIR_URL}/api/line-quota`, {
      headers: REPAIR_HDR,
      timeout: 5000,
    });
    if (r.data?.ok) {
      _quotaCache = r.data.usage || 0;
      _quotaExp = Date.now() + 5 * 60 * 1000; // cache 5 นาที
      return _quotaCache;
    }
  } catch (e) {
    console.warn('[NotifyHub] getLineQuotaUsage failed:', e.message);
  }
  return _quotaCache || 0;
}

// ── เพิ่ม Quota count +1 ──────────────────────────────────────
async function incrementLineQuota() {
  _quotaCache = null; // invalidate cache
  try {
    await axios.post(`${REPAIR_URL}/api/line-quota/increment`, {}, {
      headers: REPAIR_HDR,
      timeout: 5000,
    });
  } catch (e) {
    console.warn('[NotifyHub] incrementLineQuota failed:', e.message);
  }
}

// ── ตรวจว่า LINE ยังส่งได้ไหม ────────────────────────────────
async function canSendLine() {
  const usage = await getLineQuotaUsage();
  const canSend = usage < LINE_QUOTA_LIMIT;
  if (!canSend) {
    console.warn(`[NotifyHub] LINE Quota FULL: ${usage}/${LINE_QUOTA_LIMIT} — skip LINE`);
  }
  return canSend;
}

// ── ตรวจว่าเป็น Event วันนี้ไหม (Real-Time Only) ─────────────
// ใช้ submitted_at (วันที่ POST /api/tickets) เป็นหลัก
// ห้ามส่ง Event ที่ submitted ก่อนวันนี้
function isTodayEvent(submittedAt) {
  if (!submittedAt) return true; // ถ้าไม่มีค่า → อนุญาต (event ใหม่สุด)
  const today = new Date();
  const submitted = new Date(submittedAt);

  const todayStr = today.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });
  const submittedStr = submitted.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });

  const isToday = todayStr === submittedStr;
  if (!isToday) {
    console.log(`[NotifyHub] Old event (${submittedStr}) vs today (${todayStr}) — skip notification`);
  }
  return isToday;
}

// ── ตรวจ Duplicate: เคยส่งแล้วไหม ───────────────────────────
async function alreadySent(eventId, channel) {
  try {
    const r = await axios.get(`${REPAIR_URL}/api/notification-log/check`, {
      params: { event_id: eventId, channel },
      headers: REPAIR_HDR,
      timeout: 5000,
    });
    return r.data?.exists || false;
  } catch (e) {
    console.warn('[NotifyHub] alreadySent check failed:', e.message);
    return false; // ถ้าเช็คไม่ได้ → ยังส่งได้ (fail-open)
  }
}

// ── บันทึก Log ──────────────────────────────────────────────
async function saveLog({ eventId, eventType, channel, status, errorMsg }) {
  try {
    await axios.post(`${REPAIR_URL}/api/notification-log`, {
      event_id:   eventId,
      event_type: eventType,
      event_date: new Date().toISOString().split('T')[0],
      channel,
      status,
      error_msg:  errorMsg || null,
      sent_at:    new Date().toISOString(),
    }, { headers: REPAIR_HDR, timeout: 5000 });
  } catch (e) {
    console.warn('[NotifyHub] saveLog failed:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// Core: sendBoth — ส่งทั้ง LINE + Telegram พร้อมกัน
// ══════════════════════════════════════════════════════════════
async function sendBoth({ eventId, eventType, submittedAt, lineAction, telegramAction }) {
  // 1. ตรวจ Real-Time Only
  if (!isTodayEvent(submittedAt)) {
    console.log(`[NotifyHub] SKIP (old event) — ${eventId}`);
    return { line: 'skipped_old_event', telegram: 'skipped_old_event' };
  }

  const result = { line: null, telegram: null };

  // 2. LINE
  const lineSent = await alreadySent(eventId, 'LINE');
  if (lineSent) {
    result.line = 'already_sent';
  } else {
    const lineOk = await canSendLine();
    if (!lineOk) {
      result.line = 'quota_exceeded';
      await saveLog({ eventId, eventType, channel: 'LINE', status: 'SKIPPED_QUOTA' });
    } else {
      try {
        await lineAction();
        await incrementLineQuota();
        result.line = 'sent';
        await saveLog({ eventId, eventType, channel: 'LINE', status: 'SUCCESS' });
      } catch (e) {
        result.line = 'failed';
        console.error('[NotifyHub] LINE error:', e.message);
        await saveLog({ eventId, eventType, channel: 'LINE', status: 'FAILED', errorMsg: e.message });
      }
    }
  }

  // 3. Telegram — ส่งเสมอ ไม่สนใจ LINE status
  const tgSent = await alreadySent(eventId, 'TELEGRAM');
  if (tgSent) {
    result.telegram = 'already_sent';
  } else {
    try {
      await telegramAction();
      result.telegram = 'sent';
      await saveLog({ eventId, eventType, channel: 'TELEGRAM', status: 'SUCCESS' });
    } catch (e) {
      result.telegram = 'failed';
      console.error('[NotifyHub] Telegram error:', e.message);
      await saveLog({ eventId, eventType, channel: 'TELEGRAM', status: 'FAILED', errorMsg: e.message });
    }
  }

  console.log(`[NotifyHub] ${eventId} | LINE: ${result.line} | TG: ${result.telegram}`);
  return result;
}

// ══════════════════════════════════════════════════════════════
// Public API — ตรงกับ lineNotify.js ทุก function
// app.js เปลี่ยน lineNotify → notifyHub แค่นั้น
// ══════════════════════════════════════════════════════════════

async function notifyNewTicket(ticket) {
  const eventId = `ticket_new_${ticket.id || ticket._recordId}`;
  return sendBoth({
    eventId,
    eventType: 'new_ticket',
    submittedAt: ticket.createdAt || ticket.sentDate || new Date().toISOString(),
    lineAction:     () => lineNotify.notifyNewTicket(ticket),
    telegramAction: () => telegram.notifyNewTicket(ticket),
  });
}

async function notifyAssigned(ticket, engineerLineId, engineerTelegramId) {
  const eventId = `ticket_assign_${ticket.id || ticket._recordId}_${Date.now()}`;
  return sendBoth({
    eventId,
    eventType: 'assigned',
    submittedAt: new Date().toISOString(), // assign = action ทันที
    lineAction:     () => lineNotify.notifyAssigned(ticket, engineerLineId),
    telegramAction: () => telegram.notifyAssigned(ticket, engineerTelegramId),
  });
}

async function notifyWorkSubmitted(ticket) {
  const eventId = `ticket_submit_${ticket.id || ticket._recordId}_${Date.now()}`;
  return sendBoth({
    eventId,
    eventType: 'work_submitted',
    submittedAt: new Date().toISOString(),
    lineAction:     () => lineNotify.notifyWorkSubmitted(ticket),
    telegramAction: () => telegram.notifyWorkSubmitted(ticket),
  });
}

async function notifyTicketClosed(ticket) {
  const eventId = `ticket_close_${ticket.id || ticket._recordId}_${Date.now()}`;
  return sendBoth({
    eventId,
    eventType: 'closed',
    submittedAt: new Date().toISOString(),
    lineAction:     () => lineNotify.notifyTicketClosed(ticket),
    telegramAction: () => telegram.notifyTicketClosed(ticket),
  });
}

async function notifyRevision(ticket, engineerLineId, engineerTelegramId) {
  const eventId = `ticket_revision_${ticket.id || ticket._recordId}_${Date.now()}`;
  return sendBoth({
    eventId,
    eventType: 'revision',
    submittedAt: new Date().toISOString(),
    lineAction:     () => lineNotify.notifyRevision(ticket, engineerLineId),
    telegramAction: () => telegram.notifyRevision(ticket, engineerTelegramId),
  });
}

async function notifyReassigned(ticket, oldEngLineId, newEngLineId, oldEngTgId, newEngTgId) {
  const eventId = `ticket_reassign_${ticket.id || ticket._recordId}_${Date.now()}`;
  return sendBoth({
    eventId,
    eventType: 'reassigned',
    submittedAt: new Date().toISOString(),
    lineAction:     () => lineNotify.notifyReassigned(ticket, oldEngLineId, newEngLineId),
    telegramAction: () => telegram.notifyReassigned(ticket, oldEngTgId, newEngTgId),
  });
}

// push ตรง (ใช้แทน lineNotify.push ถ้าจำเป็น)
async function push(to, messages) {
  return lineNotify.push(to, messages);
}

// ── Quota Info สำหรับ Admin Dashboard ────────────────────────
async function getQuotaInfo() {
  const usage = await getLineQuotaUsage();
  const tgStatus = await telegram.checkBotStatus();
  return {
    line: {
      usage,
      limit:   LINE_QUOTA_LIMIT,
      percent: Math.round((usage / LINE_QUOTA_LIMIT) * 100),
      isFull:  usage >= LINE_QUOTA_LIMIT,
    },
    telegram: {
      connected: tgStatus.ok,
      botName:   tgStatus.botName,
      unlimited: true,
    },
  };
}

module.exports = {
  notifyNewTicket,
  notifyAssigned,
  notifyWorkSubmitted,
  notifyTicketClosed,
  notifyRevision,
  notifyReassigned,
  push,
  getQuotaInfo,
  getLineQuotaUsage,
};
