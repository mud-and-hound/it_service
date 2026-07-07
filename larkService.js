// larkService.js — Ticket CRUD via FastAPI → MySQL
// Render.com → FastAPI (repair.mobile1234.site) → MySQL (10.8.1.88)
// ชื่อไฟล์ยังคงเดิมเพื่อไม่ต้องแก้ require() ทุกที่

const axios = require('axios');

const API_BASE = process.env.REPAIR_API_URL || process.env.FASTAPI_URL || 'https://repair.mobile1234.site';
const API_KEY  = process.env.REPAIR_API_KEY || process.env.API_KEY     || 'repair123';
const headers  = { 'X-API-Key': API_KEY };

// ── Cache (จำกัด 500 tickets, expire 30 วินาที) ─────────────────
let _cache = null;
let _cacheExp = 0;
const CACHE_MAX = 500;

function invalidateCache() { _cache = null; _cacheExp = 0; }

// ── mapTicket: FastAPI → frontend format ──────────────────────
function mapTicket(t) {
  return {
    _recordId:    t.ticket_id    || t._recordId    || t.id          || '',
    id:           t.ticket_id    || t.id           || t._recordId   || '',
    status:       mapStatus(t.status),
    brand:        t.brand        || '',
    branchCode:   t.branchCode   || t.branch_code  || '',
    reporter:     t.reporter     || '',
    phone:        t.phone        || '',
    type:         t.type         || '',
    detail:       t.detail       || '',
    location:     t.location     || '',
    sentDate:     t.sentDate     || t.sent_date    || '',
    slaDate:      t.slaDate      || t.sla_date     || '',
    assignedTo:   t.assignedTo   || t.assigned_to  || '',
    engineerName: t.engineerName || t.engineer_name|| '',
    workDetail:   t.workDetail   || t.work_detail  || '',
    partsUsed:    t.partsUsed    || t.parts_used   || '',
    workHours:    t.workHours    || t.work_hours   || '',
    lineUserId:   t.lineUserId   || t.line_user_id || '',
    createdAt:    t.createdAt    || t.created_at   || '',
    sla:          t.sla          || '',
    adminNote:    t.adminNote    || t.admin_note   || '',
    stuckNote:    t.stuckNote    || t.stuck_note   || '',
    closedAt:     t.closedAt     || t.closed_at    || '',
    closedBy:     t.closedBy     || t.closed_by    || '',
    completedAt:  t.completedAt  || t.completed_at || '',
    startedAt:    t.startedAt    || t.started_at   || '',
    completedLat:     t.completedLat     || t.completed_lat    || null,
    completedLng:     t.completedLng     || t.completed_lng    || null,
    images:           t.images            || null,
    images_reporter:  t.images_reporter   || null,
    images_engineer:  t.images_engineer   || null,
  };
}

// Map status MySQL/English → Thai display
function mapStatus(s) {
  if (!s) return 'รอดำเนินการ ⏱️';
  const map = {
    'pending':        'รอดำเนินการ ⏱️',
    'in_progress':    'อยู่ระหว่างดำเนินการ ⚙️',
    'waiting_parts':  'รออะไหล่ 📦',
    'waiting_vendor': 'รอซัพดำเนินการซ่อม 🔧',
    'review':         'ตรวจงาน',
    'done':           'เสร็จสิ้น ✅',
    'cancelled':      'ยกเลิก ❌',
  };
  if (map[s]) return map[s];
  // Thai string ที่อาจมี emoji แล้ว — normalize
  // ⚠️ ลำดับสำคัญ: เช็ค 2 สถานะใหม่ก่อน "รอดำเนินการ" กัน match ผิด
  if (s.includes('รออะไหล่'))             return 'รออะไหล่ 📦';
  if (s.includes('รอซัพ'))                return 'รอซัพดำเนินการซ่อม 🔧';
  if (s.includes('รอดำเนินการ'))          return 'รอดำเนินการ ⏱️';
  if (s.includes('อยู่ระหว่างดำเนินการ')) return 'อยู่ระหว่างดำเนินการ ⚙️';
  if (s.includes('ตรวจงาน'))              return 'ตรวจงาน';
  if (s.includes('เสร็จสิ้น'))            return 'เสร็จสิ้น ✅';
  if (s.includes('ยกเลิก'))               return 'ยกเลิก ❌';
  return s;
}

// Map status Thai → MySQL English
function mapStatusReverse(s) {
  if (!s) return 'pending';
  // ⚠️ ลำดับสำคัญ: เช็ค 2 สถานะใหม่ก่อน "รอดำเนินการ" กัน match ผิด
  // (เผื่อ frontend ส่ง key อังกฤษมาตรงๆ ก็รองรับด้วย)
  if (s === 'waiting_parts'  || s.includes('รออะไหล่')) return 'waiting_parts';
  if (s === 'waiting_vendor' || s.includes('รอซัพ'))    return 'waiting_vendor';
  if (s.includes('รอดำเนินการ'))          return 'pending';
  if (s.includes('อยู่ระหว่างดำเนินการ')) return 'in_progress';
  if (s.includes('ตรวจงาน'))              return 'review';
  if (s.includes('เสร็จสิ้น'))            return 'done';
  if (s.includes('ยกเลิก'))               return 'cancelled';
  return 'pending';
}

// ── listTickets ────────────────────────────────────────────────
async function listTickets(opts = {}) {
  if (_cache && Date.now() < _cacheExp && !opts?.noCache) return _cache;
  try {
    const r = await axios.get(`${API_BASE}/api/tickets`, {
      headers,
      params: { limit: 500 },
      timeout: 15000,
    });
    const tickets = (r.data.tickets || []).slice(0, CACHE_MAX).map(mapTicket);
    _cache = tickets;
    _cacheExp = Date.now() + 30_000;
    return tickets;
  } catch(e) {
    console.error('[larkService] listTickets error:', e.message);
    return _cache || [];
  }
}

// ── getTicket ──────────────────────────────────────────────────
async function getTicket(recordId) {
  try {
    const r = await axios.get(`${API_BASE}/api/tickets/${recordId}`, {
      headers, timeout: 25000,
    });
    return mapTicket(r.data);
  } catch(e) {
    console.error('[larkService] getTicket error:', e.message);
    // fallback: ค้นหาจาก cache
    if (_cache) {
      const t = _cache.find(x => x._recordId === recordId || x.id === recordId);
      if (t) return t;
    }
    throw e;
  }
}

// ── createTicket ───────────────────────────────────────────────
async function createTicket(data) {
  try {
    const payload = {
      brand:        data.brand,
      branch_code:  data.branchCode || '',
      reporter:     data.reporter,
      phone:        data.phone,
      type:         data.type || '',
      detail:       data.detail,
      location:     data.location || '',
      line_user_id: data.lineUserId || null,
    };
    const r = await axios.post(`${API_BASE}/api/tickets`, payload, {
      headers, timeout: 25000,
    });
    invalidateCache();
    const tickets = await listTickets({ noCache: true });
    const newTicket = tickets.find(t => t.id === r.data.ticket_id);
    return newTicket || { _recordId: r.data.ticket_id, id: r.data.ticket_id, ...data };
  } catch(e) {
    console.error('[larkService] createTicket error:', e.message);
    throw e;
  }
}

// ── updateTicket ───────────────────────────────────────────────
// FastAPI TicketUpdate รองรับ 14 fields — map ครบทุกตัว
async function updateTicket(recordId, data) {
  try {
    const payload = {};

    // ── Core fields ──
    if (data.status !== undefined)
      payload.status = mapStatusReverse(data.status);
    if (data.engineerName !== undefined)
      payload.engineer_name = data.engineerName;
    if (data.assignedTo !== undefined)
      payload.assigned_to = data.assignedTo;
    if (data.workDetail !== undefined)
      payload.work_detail = data.workDetail;
    if (data.partsUsed !== undefined)
      payload.parts_used = data.partsUsed;
    if (data.workHours !== undefined && data.workHours !== '')
      payload.work_hours = parseFloat(data.workHours) || null;

    // ── Admin / Close fields (เคยหายไป — ทำให้ปิดงานไม่สำเร็จ) ──
    if (data.adminNote !== undefined)
      payload.admin_note = data.adminNote;
    if (data.stuck_note !== undefined)
      payload.stuck_note = data.stuck_note;
    if (data.closedBy !== undefined)
      payload.closed_by = data.closedBy;
    if (data.closedAt !== undefined)
      payload.closed_at = data.closedAt;
    if (data.slaDate !== undefined || data.sla_date !== undefined)
      payload.sla_date = data.slaDate || data.sla_date;
    if (data.completedAt !== undefined)
      payload.completed_at = data.completedAt;

    // ── Timestamp / GPS fields ──
    // หมายเหตุ: started_at ไม่ส่งไป FastAPI (ยังไม่รองรับ) — เก็บใน localStorage ฝั่ง frontend
    if (data.completed_lat !== undefined)
      payload.completed_lat = parseFloat(data.completed_lat) || null;
    if (data.completed_lng !== undefined)
      payload.completed_lng = parseFloat(data.completed_lng) || null;

    if (Object.keys(payload).length === 0) {
      console.warn('[ticketService] updateTicket: no supported fields to update');
      if (_cache) {
        const t = _cache.find(x => x._recordId === recordId);
        if (t) return t;
      }
      return await getTicket(recordId);
    }

    await axios.patch(`${API_BASE}/api/tickets/${recordId}`, payload, {
      headers, timeout: 25000,
    });
    invalidateCache();
    return await getTicket(recordId);
  } catch(e) {
    console.error('[ticketService] updateTicket error:', e.message);
    throw e;
  }
}

// ── stubs (ไม่ใช้แล้วแต่ export ไว้กัน error) ──────────────
async function getToken() { return 'not-used'; }
async function ensureFieldMap() { return true; }
async function debugSchema() { return { fieldMap: {}, schema: [] }; }

module.exports = {
  listTickets, getTicket, createTicket, updateTicket,
  invalidateCache, getToken, ensureFieldMap, debugSchema,
};
