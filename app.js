// app.js — IT Ticket System v2
const express = require('express');
const path    = require('path');
const { hashPwd, createSession, getSession, deleteSession, requireAuth, addLog, getLogs, getLogsAsync } = require('./auth');
const { getAllUsers, getUserByUsername, getUserByUsernameAndBrand, getAllReporters, createUser, updateUser, deleteUser } = require('./users');
const { listTickets, getTicket, updateTicket, createTicket, debugSchema, ensureFieldMap, invalidateCache } = require('./larkService');
const larkRouter   = require('./larkWebhook');
const lineRouter   = require('./lineWebhook');
const lineNotify   = require('./lineNotify');
const lineConfig   = require('./lineConfig');
const notifyHub    = require('./notifyHub');   // ← NEW: Hybrid LINE + Telegram

const app = express();
app.use(express.json({ limit:'10mb', verify:(req,_,buf)=>{ req.rawBody=buf; } }));
app.use(express.urlencoded({ extended:true }));

// ── Request timeout ─────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/api/events') return next();
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.warn(`[Timeout] ${req.method} ${req.path} — 60s`);
      res.status(503).json({ ok:false, error:'Request timeout' });
    }
  }, 60_000);
  res.on('finish', () => clearTimeout(timer));
  res.on('close',  () => clearTimeout(timer));
  next();
});

// ── SSE ─────────────────────────────────────────────────────
const clients = new Set();
function broadcast(evt, data) {
  const msg = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try{ res.write(msg); }catch(_){ clients.delete(res); } });
}
app.locals.broadcast = broadcast;

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' });
  res.flushHeaders();
  res.write('data: connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ── Health ──────────────────────────────────────────────────
app.get('/health', (_, res) => {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024;
  res.json({ ok:true, ts:Date.now(), uptime:Math.floor(process.uptime()), memory:`${mb.toFixed(0)}MB` });
});

// ── Static ──────────────────────────────────────────────────
app.get('/', (_, res) => res.redirect('/Itsupportlanding'));
const noCacheHtml = (file) => (_, res) => {
  res.set({ 'Cache-Control':'no-store,no-cache,must-revalidate','Pragma':'no-cache','Expires':'0' });
  res.sendFile(path.join(__dirname, file));
};
app.get('/Itsupportlanding', noCacheHtml('itsupport-landing.html'));
app.get('/landing',          noCacheHtml('itsupport-landing.html'));
app.get('/report',           noCacheHtml('report.html'));
app.get('/report/:brand',    noCacheHtml('report.html'));
app.get('/admin',            noCacheHtml('admin.html'));
app.get('/engineer',         noCacheHtml('engineer.html'));
// ── Notification Center ─────────────────────────────────────
app.get('/notifications', requireAuth(['superadmin','admin','manager','it_services']), noCacheHtml('notification-center.html'));

// ── Auth ────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password, brand } = req.body || {};
    if (!username || !password) return res.json({ ok:false, error:'กรุณากรอก username และ password' });
    const user = brand
      ? (getUserByUsernameAndBrand(username, brand) || getUserByUsername(username))
      : getUserByUsername(username);
    if (!user) return res.json({ ok:false, error:`ไม่พบ username "${username}"` });
    if (!user.active) return res.json({ ok:false, error:'บัญชีนี้ถูกระงับ' });
    if (user.password !== hashPwd(password)) return res.json({ ok:false, error:'รหัสผ่านไม่ถูกต้อง' });
    const isDefaultPwd = user.password_plain && user.password === hashPwd(user.password_plain)
      && user.password_plain === username.replace(/^[GABPDF]/,'').replace(/^0+/,'');
    const token = createSession(user);
    addLog({ user, action:'login', detail:`เข้าสู่ระบบ (${user.role})` });
    res.json({
      ok: true, token,
      user: {
        id: user.id, name: user.name, username: user.username,
        role: user.role, brand: user.brand,
        phone: user.phone || '', email: user.email || '',
        nickname: user.nickname || '',
        is_default_password: !!(user.role === 'reporter' && isDefaultPwd),
        reset_requested: !!(user.reset_requested),
      }
    });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.post('/api/auth/logout', requireAuth(), (req, res) => {
  addLog({ user:req.user, action:'logout' });
  deleteSession(req.token);
  res.json({ ok:true });
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  res.json({ ok:true, user: req.user });
});

// ═══════════════════════════════════════════════════════════
// LINE SETTINGS API
// ═══════════════════════════════════════════════════════════
app.get('/api/line-config', requireAuth(['superadmin','admin','it_services']), async (req, res) => {
  try {
    const flat = await lineConfig.getConfig();
    const config = {
      adminGroupId: flat['admin_group_id'] || '',
      brandGroups: {
        "Dunkin'"             : flat['brand_group_dunkin']              || '',
        "Greyhound Cafe'"     : flat['brand_group_greyhound_cafe']      || '',
        "Greyhound Original"  : flat['brand_group_greyhound_original']  || '',
        "Au Bon Pain"         : flat['brand_group_au_bon_pain']         || '',
        "Funky Fries"         : flat['brand_group_funky_fries']         || '',
        "Another Hound Cafe'" : flat['brand_group_another_hound']       || '',
        "Bean Hound"          : flat['brand_group_bean_hound']          || '',
      },
    };
    res.json({ ok:true, config, hasToken:lineConfig.hasToken(), tokenPreview:lineConfig.getTokenPreview() });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.patch('/api/line-config', requireAuth(['superadmin','admin','it_services']), async (req, res) => {
  try {
    const updated = await lineConfig.updateConfig(req.body);
    addLog({ user:req.user, action:'update_line_config', detail:'อัปเดตค่า LINE Settings' });
    res.json({ ok:true, config:updated });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.post('/api/line-config/test', requireAuth(['superadmin','admin','it_services']), async (req, res) => {
  try {
    const { to } = req.body || {};
    if (!to) return res.json({ ok:false, error:'กรุณาระบุ LINE ID ที่ต้องการทดสอบ' });
    const result = await lineNotify.push(to, [{ type:'text', text:'Test from IT Support Hub — LINE connection OK' }]);
    addLog({ user:req.user, action:'test_line', detail:`ทดสอบ LINE -> ${to.slice(0,12)}... result=${result.ok}` });
    res.json(result);
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.get('/api/line/diagnostic', requireAuth(['superadmin','admin','it_services']), async (req, res) => {
  try {
    const diag = await lineNotify.sendDiagnostic();
    res.json({ ok:true, diagnostic: diag });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.get('/api/line/quota', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
    if (!token) return res.json({ ok:false, error:'No LINE token' });
    const axios = require('axios');
    const headers = { Authorization: `Bearer ${token}` };
    const [qRes, uRes] = await Promise.all([
      axios.get('https://api.line.me/v2/bot/message/quota', { headers, timeout:8000 }),
      axios.get('https://api.line.me/v2/bot/message/quota/consumption', { headers, timeout:8000 }),
    ]);
    res.json({
      ok: true,
      type:       qRes.data?.type,
      limit:      qRes.data?.value ?? 0,
      totalUsage: uRes.data?.totalUsage ?? 0,
    });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

// ═══════════════════════════════════════════════════════════
// NOTIFICATION CENTER API  ← NEW
// ═══════════════════════════════════════════════════════════
app.get('/api/notify-status', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'https://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    // ดึง quota info (LINE live + Telegram status) และ today stats พร้อมกัน
    const [quotaInfo, statusRes] = await Promise.all([
      notifyHub.getQuotaInfo(),
      axios.get(`${REPAIR_URL}/api/notify-status`, {
        headers: { 'X-API-Key': REPAIR_KEY }, timeout: 5000,
      }).catch(() => ({ data: { today: {}, date: '' } })),
    ]);
    res.json({
      ok: true,
      quota: quotaInfo,
      today: statusRes.data?.today || {},
      date:  statusRes.data?.date  || new Date().toISOString().split('T')[0],
    });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.get('/api/notification-log', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'https://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const r = await axios.get(`${REPAIR_URL}/api/notification-log`, {
      params: { limit: req.query.limit || 200, channel: req.query.channel || undefined, status: req.query.status || undefined },
      headers: { 'X-API-Key': REPAIR_KEY }, timeout: 8000,
    });
    res.json(r.data);
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.patch('/api/line-quota', requireAuth(['superadmin','admin','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'https://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const r = await axios.patch(`${REPAIR_URL}/api/line-quota`, req.body, {
      headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type': 'application/json' }, timeout: 5000,
    });
    addLog({ user:req.user, action:'sync_line_quota', detail:`Sync LINE Quota = ${req.body?.usage}` });
    res.json(r.data);
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

// ═══════════════════════════════════════════════════════════
// BRANCHES — MySQL via FastAPI
// ═══════════════════════════════════════════════════════════
let _branchCache = null, _branchCacheExp = 0;

app.get('/api/branches', async (req, res) => {
  try {
    if (_branchCache && Date.now() < _branchCacheExp) return res.json({ ok:true, branches:_branchCache });
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const r = await axios.get(`${REPAIR_URL}/api/branches`, {
      headers: { 'X-API-Key': REPAIR_KEY },
      timeout: 25000
    });
    if (!r.data?.ok) throw new Error('branches API error');
    const result = {};
    for (const b of (r.data.branches || [])) {
      const brand = b.brand || 'Unknown';
      if (!result[brand]) result[brand] = [];
      result[brand].push({
        id:           b.id,
        code:         b.code,
        shortCode:    b.shortCode || b.short_code || '',
        nameTh:       b.nameTh || b.name_th || '',
        nameEn:       b.nameEn || b.name_en || '',
        ip:           b.ip || '',
        phone:        b.phone || '',
        storePhone:   b.storePhone   || b.store_phone   || '',
        managerPhone: b.managerPhone || b.manager_phone || '',
        location_lat:  b.location_lat  || null,
        location_lng:  b.location_lng  || null,
        location_name: b.location_name || '',
      });
    }
    _branchCache = result;
    _branchCacheExp = Date.now() + 5 * 60 * 1000;
    res.json({ ok:true, branches:result });
  } catch(e) {
    console.error('[branches]', e.message);
    if (_branchCache) return res.json({ ok:true, branches:_branchCache, cached:true });
    res.json({ ok:false, error:e.message });
  }
});

app.post('/api/branches', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const body = { ...(req.body || {}) };
    if (req.user) {
      body.role = body.role || req.user.role || 'superadmin';
      body.created_by = body.created_by || req.user.username || req.user.name || 'admin';
    }
    const r = await axios.post(`${REPAIR_URL}/api/branches`, body, {
      headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type': 'application/json' }, timeout: 60000
    });
    _branchCache = null; _branchCacheExp = 0;
    addLog({ user: req.user, action: 'create_branch', detail: `สร้างสาขา ${body.code} (${body.brand})` });
    res.json(r.data);
  } catch(e) {
    console.error('[branch create]', e.message, e.response?.data);
    if (!res.headersSent) res.status(e.response?.status || 500).json({ ok: false, error: e.response?.data?.detail || e.message });
  }
});

app.patch('/api/branches/:id', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const { id } = req.params;
    const body = { ...(req.body || {}) };
    if (req.user) {
      body.role = body.role || req.user.role || 'superadmin';
      body.updated_by = body.updated_by || req.user.username || req.user.name || 'admin';
    }
    const r = await axios.patch(`${REPAIR_URL}/api/branches/${id}`, body, {
      headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type': 'application/json' }, timeout: 60000
    });
    _branchCache = null; _branchCacheExp = 0;
    addLog({ user: req.user, action: 'update_branch', detail: `อัปเดตสาขา id=${id} fields=${Object.keys(body).join(',')}` });
    res.json(r.data);
  } catch(e) {
    console.error('[branch patch]', e.message, e.response?.data);
    if (!res.headersSent) res.status(e.response?.status || 500).json({ ok: false, error: e.response?.data?.detail || e.message });
  }
});

app.delete('/api/branches/:id', requireAuth(['superadmin']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const r = await axios.delete(`${REPAIR_URL}/api/branches/${req.params.id}`, {
      headers: { 'X-API-Key': REPAIR_KEY }, timeout: 30000
    });
    _branchCache = null; _branchCacheExp = 0;
    addLog({ user: req.user, action: 'delete_branch', detail: `ลบสาขา id=${req.params.id}` });
    res.json(r.data);
  } catch(e) {
    console.error('[branch delete]', e.message, e.response?.data);
    if (!res.headersSent) res.status(e.response?.status || 500).json({ ok: false, error: e.response?.data?.detail || e.message });
  }
});

app.post('/api/branches/:id/approve', requireAuth(['superadmin','admin','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const body = { approved_by: req.user?.username || req.user?.name || 'admin', ...(req.body || {}) };
    const r = await axios.post(`${REPAIR_URL}/api/branches/${req.params.id}/approve`, body, {
      headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type': 'application/json' }, timeout: 30000
    });
    _branchCache = null; _branchCacheExp = 0;
    addLog({ user: req.user, action: 'approve_branch', detail: `อนุมัติสาขา id=${req.params.id}` });
    res.json(r.data);
  } catch(e) {
    console.error('[branch approve]', e.message);
    if (!res.headersSent) res.json({ ok: false, error: e.message });
  }
});

app.post('/api/branches/:id/reject', requireAuth(['superadmin','admin','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const body = { ...(req.body || {}) };
    const r = await axios.post(`${REPAIR_URL}/api/branches/${req.params.id}/reject`, body, {
      headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type': 'application/json' }, timeout: 30000
    });
    _branchCache = null; _branchCacheExp = 0;
    addLog({ user: req.user, action: 'reject_branch', detail: `ปฏิเสธสาขา id=${req.params.id} reason=${body.reason||'-'}` });
    res.json(r.data);
  } catch(e) {
    console.error('[branch reject]', e.message);
    if (!res.headersSent) res.json({ ok: false, error: e.message });
  }
});

app.get('/api/resolve-gmaps', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.json({ ok: false, error: 'No URL provided' });
    const axios = require('axios');
    const response = await axios.get(url, {
      maxRedirects: 10, timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IT-Support-Bot/1.0)' },
      validateStatus: () => true,
    });
    const finalUrl = response.request?.res?.responseUrl || response.config?.url || url;
    const patterns = [
      /@(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/,
      /\/(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    ];
    for (const re of patterns) {
      const m = finalUrl.match(re);
      if (m) {
        const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)
          return res.json({ ok: true, lat, lng, finalUrl });
      }
    }
    res.json({ ok: false, error: 'ไม่พบพิกัดในลิงก์', finalUrl });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// UPLOAD — proxy to FastAPI
// ═══════════════════════════════════════════════════════════
app.post('/api/upload', async (req, res) => {
  try {
    const axios = require('axios');
    const FormData = require('form-data');
    const Busboy = require('busboy');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const bb = Busboy({ headers: req.headers });
    const fields = {};
    let fileBuffer = null, fileName = 'upload.jpg', fileMime = 'image/jpeg';
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      fileName = info.filename || 'upload.jpg';
      fileMime = info.mimeType || 'image/jpeg';
      const chunks = [];
      stream.on('data', d => chunks.push(d));
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('finish', async () => {
      try {
        const fd = new FormData();
        fd.append('file', fileBuffer, { filename: fileName, contentType: fileMime });
        fd.append('ticket_id', fields.ticket_id || '');
        fd.append('role', fields.role || 'reporter');
        const r = await axios.post(`${REPAIR_URL}/api/upload`, fd, {
          headers: { 'X-API-Key': REPAIR_KEY, ...fd.getHeaders() }, timeout: 30000
        });
        res.json(r.data);
      } catch(e) { if(!res.headersSent) res.json({ ok: false, error: e.message }); }
    });
    req.pipe(bb);
  } catch(e) { if(!res.headersSent) res.json({ ok: false, error: e.message }); }
});

app.get('/uploads/:filename', async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const r = await axios.get(`${REPAIR_URL}/uploads/${req.params.filename}`, {
      headers: { 'X-API-Key': REPAIR_KEY }, responseType: 'stream', timeout: 15000
    });
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    r.data.pipe(res);
  } catch(e) { res.status(404).json({ error: 'Not found' }); }
});

app.patch('/api/users/:id/preference', requireAuth(), async (req, res) => {
  try {
    const { ui_preference } = req.body || {};
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const r = await axios.patch(`${REPAIR_URL}/api/users/${req.params.id}`,
      { ui_preference }, { headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type': 'application/json' }, timeout: 8000 });
    res.json(r.data);
  } catch(e) { if(!res.headersSent) res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// TICKETS
// ═══════════════════════════════════════════════════════════
const _ticketBrandCache = new Map();

app.get('/api/tickets', async (req, res) => {
  try {
    let tickets = await Promise.race([
      listTickets(),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),15000))
    ]).catch(async()=>{ try{return await require('./larkService').listTickets({noCache:false})||[];}catch(_){return[];} });
    const s = getSession((req.headers.authorization||'').slice(7));
    if (s&&s.user.role==='engineer'&&s.user.brand!=='ALL') tickets=tickets.filter(t=>t.brand===s.user.brand);
    tickets.forEach(t=>{ if(t._recordId&&t.brand) _ticketBrandCache.set(t._recordId,t.brand); });
    global._debugTickets = tickets;
    res.json({ ok:true, tickets });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.get('/api/tickets/:rid', async (req, res) => {
  try { res.json({ ok:true, ticket: await getTicket(req.params.rid) }); }
  catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

function getBrand(rid, body) { return body?.brand || _ticketBrandCache.get(rid) || null; }

// ── POST /api/tickets — สร้าง Ticket ใหม่ ──────────────────
// ✅ เปลี่ยน lineNotify → notifyHub (ส่งทั้ง LINE + Telegram)
app.post('/api/tickets', async (req, res) => {
  try {
    const { reporter, phone, brand, branchCode, type, detail, location } = req.body || {};
    if (!reporter||!phone||!brand||!type||!detail) return res.json({ ok:false, error:'กรุณากรอกข้อมูลให้ครบ' });
    const _n = new Date();
    const sentDateISO = `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`;
    const t = await createTicket({ reporter,phone,brand,branchCode:branchCode||'',type,detail,location:location||'',status:'รอดำเนินการ ⏱️',sentDate:sentDateISO });
    const log = addLog({ action:'create_ticket', ticketId:t._recordId, ticketLabel:t.id, detail:`สร้างโดย ${reporter} | ${brand}` });
    broadcast('ticket_created', { ticket:t });
    // ── HYBRID NOTIFY: LINE + Telegram ──
    notifyHub.notifyNewTicket(t).catch(e=>console.error('[NotifyHub newTicket]',e.message));
    res.json({ ok:true, ticket:t, log });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.post('/api/tickets/:rid/accept', requireAuth(['engineer','lead_engineer','admin','superadmin','manager','it_services']), async (req, res) => {
  try {
    const brand = getBrand(req.params.rid, req.body);
    const t = await updateTicket(req.params.rid, { status:'อยู่ระหว่างดำเนินการ ⚙️', engineerName:req.user.name, assignedTo:req.user.name, brand });
    addLog({ user:req.user, action:'accept', ticketId:req.params.rid, detail:'รับงาน' });
    broadcast('ticket_updated', { recordId:req.params.rid, status:'อยู่ระหว่างดำเนินการ ⚙️', ts:new Date().toISOString() });
    res.json({ ok:true, ticket:t });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

// ── PATCH status ─────────────────────────────────────────────
app.patch('/api/tickets/:rid/status', requireAuth(), async (req, res) => {
  try {
    const { status, started_at, completed_lat, completed_lng, stuck_note } = req.body || {};
    if (!status) return res.json({ ok:false, error:'Missing status' });
    const brand = getBrand(req.params.rid, req.body);
    const updates = { status, brand };
    if (started_at) updates.started_at = started_at;
    if (completed_lat) updates.completed_lat = completed_lat;
    if (completed_lng) updates.completed_lng = completed_lng;
    if (stuck_note) updates.stuck_note = stuck_note;
    const t = await updateTicket(req.params.rid, updates);
    try { invalidateCache(); } catch(_) {}
    addLog({ user:req.user, action:'update_status', ticketId:req.params.rid, detail:`สถานะ -> ${status}${stuck_note?` (${stuck_note})`:''}` });
    broadcast('ticket_updated', { recordId:req.params.rid, status, ts:new Date().toISOString() });
    if (status.includes('แก้ไข')||status.includes('revision')) {
      const eng = getAllUsers().find(u=>u.name===t.engineerName);
      // ✅ เปลี่ยน lineNotify → notifyHub
      notifyHub.notifyRevision(t, eng?.line_user_id, eng?.telegram_user_id).catch(e=>console.error('[NotifyHub revision]',e.message));
    }
    // ── แจ้ง Admin เมื่อช่างติดขัด (รออะไหล่/รอซัพดำเนินการซ่อม) ──
    if (status.includes('รออะไหล่')||status.includes('รอซัพ')) {
      notifyHub.notifyStuckStatus?.(t, status, stuck_note).catch(e=>console.error('[NotifyHub stuck]',e.message));
    }
    res.json({ ok:true, ticket:t });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

// ── PATCH assign — มอบหมายช่าง ──────────────────────────────
// ✅ เปลี่ยน lineNotify → notifyHub
app.patch('/api/tickets/:rid/assign', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const { engineerName, assignedTo } = req.body || {};
    if (!engineerName) return res.json({ ok:false, error:'กรุณาระบุชื่อช่าง' });
    const brand = getBrand(req.params.rid, req.body);
    const t = await updateTicket(req.params.rid, { engineerName, assignedTo:assignedTo||engineerName, status:'อยู่ระหว่างดำเนินการ ⚙️', brand });
    addLog({ user:req.user, action:'assign', ticketId:req.params.rid, detail:`มอบหมาย -> ${engineerName}` });
    broadcast('ticket_updated', { recordId:req.params.rid, engineerName, status:'อยู่ระหว่างดำเนินการ ⚙️', ts:new Date().toISOString() });
    const eng = getAllUsers().find(u=>u.name===engineerName);
    notifyHub.notifyAssigned(t, eng?.line_user_id, eng?.telegram_user_id).catch(e=>console.error('[NotifyHub assign]',e.message));
    res.json({ ok:true, ticket:t });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

// ── PATCH reassign — โอนงาน ─────────────────────────────────
// ✅ เปลี่ยน lineNotify → notifyHub
app.patch('/api/tickets/:rid/reassign', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const { newEngineerName } = req.body || {};
    if (!newEngineerName) return res.json({ ok:false, error:'กรุณาระบุชื่อช่างใหม่' });
    const old = await getTicket(req.params.rid);
    const brand = getBrand(req.params.rid, req.body);
    const t = await updateTicket(req.params.rid, { engineerName:newEngineerName, assignedTo:newEngineerName, status:'อยู่ระหว่างดำเนินการ ⚙️', brand });
    addLog({ user:req.user, action:'reassign', ticketId:req.params.rid, detail:`เปลี่ยนช่าง ${old?.engineerName||'-'} -> ${newEngineerName}` });
    broadcast('ticket_updated', { recordId:req.params.rid, engineerName:newEngineerName, ts:new Date().toISOString() });
    const users = getAllUsers();
    const oldEng = users.find(u=>u.name===old?.engineerName);
    const newEng = users.find(u=>u.name===newEngineerName);
    notifyHub.notifyReassigned(t,
      oldEng?.line_user_id,     newEng?.line_user_id,
      oldEng?.telegram_user_id, newEng?.telegram_user_id
    ).catch(e=>console.error('[NotifyHub reassign]',e.message));
    res.json({ ok:true, ticket:t });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

// ── PATCH engineer-submit — ช่างส่งงาน ──────────────────────
// ✅ เปลี่ยน lineNotify → notifyHub
app.patch('/api/tickets/:rid/engineer-submit', requireAuth(['engineer','lead_engineer','admin','superadmin','manager','it_services']), async (req, res) => {
  try {
    const { workDetail, partsUsed, workHours, completed_lat, completed_lng } = req.body || {};
    if (!workDetail) return res.json({ ok:false, error:'กรุณากรอกรายละเอียดงาน' });
    const brand = getBrand(req.params.rid, req.body);
    const now = new Date().toISOString().replace('T',' ').replace(/\.\d{3}Z$/,'');
    const updates = { workDetail, partsUsed:partsUsed||'', workHours:workHours||'', engineerName:req.user.name, completedAt:now, status:'ตรวจงาน', brand };
    if (completed_lat) updates.completed_lat = completed_lat;
    if (completed_lng) updates.completed_lng = completed_lng;
    const t = await updateTicket(req.params.rid, updates);
    addLog({ user:req.user, action:'engineer_submit', ticketId:req.params.rid, detail:`ส่งงาน: ${workDetail.slice(0,50)}` });
    broadcast('ticket_updated', { recordId:req.params.rid, status:'ตรวจงาน', ts:new Date().toISOString() });
    notifyHub.notifyWorkSubmitted(t).catch(e=>console.error('[NotifyHub submit]',e.message));
    res.json({ ok:true, ticket:t });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.patch('/api/tickets/:rid/engineer', requireAuth(['engineer','lead_engineer','admin','superadmin','manager','it_services']), async (req, res) => {
  try {
    const { workDetail, status, engineerName } = req.body || {};
    if (!workDetail) return res.json({ ok:false, error:'กรุณากรอกรายละเอียดงาน' });
    const brand = getBrand(req.params.rid, req.body);
    const now = new Date().toISOString().replace('T',' ').replace(/\.\d{3}Z$/,'');
    const t = await updateTicket(req.params.rid, { workDetail, engineerName:engineerName||req.user.name, completedAt:now, status:status||'ตรวจงาน', brand });
    addLog({ user:req.user, action:'engineer_submit', ticketId:req.params.rid, detail:`ส่งงาน: ${workDetail.slice(0,50)}` });
    broadcast('ticket_updated', { recordId:req.params.rid, status:status||'ตรวจงาน', ts:new Date().toISOString() });
    notifyHub.notifyWorkSubmitted(t).catch(e=>console.error('[NotifyHub submit]',e.message));
    res.json({ ok:true, ticket:t });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

// ── PATCH close — ปิดงาน ────────────────────────────────────
// ✅ เปลี่ยน lineNotify → notifyHub
app.patch('/api/tickets/:rid/close', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const { adminNote } = req.body || {};
    const brand = getBrand(req.params.rid, req.body);
    const now = new Date().toISOString().replace('T',' ').replace(/\.\d{3}Z$/,'');
    const t = await updateTicket(req.params.rid, { status:'เสร็จสิ้น ✅', adminNote:adminNote||'', closedAt:now, closedBy:req.user.name, brand });
    addLog({ user:req.user, action:'close', ticketId:req.params.rid, detail:'ปิดงาน' });
    broadcast('ticket_updated', { recordId:req.params.rid, status:'เสร็จสิ้น ✅', ts:new Date().toISOString() });
    notifyHub.notifyTicketClosed(t).catch(e=>console.error('[NotifyHub close]',e.message));
    res.json({ ok:true, ticket:t });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.patch('/api/tickets/:rid', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const brand = getBrand(req.params.rid, req.body);
    const t = await updateTicket(req.params.rid, { ...req.body, brand });
    addLog({ user:req.user, action:'update', ticketId:req.params.rid, detail:'อัปเดต' });
    broadcast('ticket_updated', { recordId:req.params.rid, ts:new Date().toISOString() });
    res.json({ ok:true, ticket:t });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.delete('/api/tickets/:rid', requireAuth(['superadmin','admin']), async (req, res) => {
  try {
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    const auditBody = { deleted_by: req.user?.username || req.user?.name || 'admin' };
    try {
      await axios.delete(`${REPAIR_URL}/api/tickets/${req.params.rid}`, {
        headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type': 'application/json' },
        data: auditBody, timeout: 30000
      });
    } catch(e) { if (e.response?.status !== 404) throw e; }
    try { invalidateCache(); } catch(_) {}
    addLog({ user: req.user, action: 'delete_ticket', ticketId: req.params.rid, detail: 'ลบ ticket (soft delete)' });
    broadcast('ticket_deleted', { recordId: req.params.rid, ts: new Date().toISOString() });
    res.json({ ok: true });
  } catch(e) {
    console.error('[ticket delete]', e.message, e.response?.data);
    if (!res.headersSent) res.status(e.response?.status || 500).json({ ok: false, error: e.response?.data?.detail || e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// LOGS / USERS
// ═══════════════════════════════════════════════════════════
app.get('/api/logs', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const logs = await getLogsAsync({
      limit:    parseInt(req.query.limit)    || 200,
      userName: req.query.userName           || null,
      action:   req.query.action             || null,
      dateFrom: req.query.dateFrom           || null,
      dateTo:   req.query.dateTo             || null,
      ticketId: req.query.ticketId           || null,
    });
    res.json({ ok:true, logs });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.get('/api/users', requireAuth(['superadmin','admin','manager','it_services']), (_, res) => res.json({ ok:true, users:getAllUsers() }));
app.post('/api/users', requireAuth(['superadmin','admin','it_services']), (req, res) => {
  try { const u=createUser(req.body); addLog({user:req.user,action:'create_user',detail:`สร้าง ${u.username}`}); res.json({ok:true,user:u}); }
  catch(e) { if(!res.headersSent) res.json({ok:false,error:e.message}); }
});
app.patch('/api/users/:id', requireAuth(['superadmin','admin','it_services']), (req, res) => {
  try { const u=updateUser(req.params.id,req.body); addLog({user:req.user,action:'update_user',detail:`แก้ไข ${u.username}`}); res.json({ok:true,user:u}); }
  catch(e) { if(!res.headersSent) res.json({ok:false,error:e.message}); }
});
app.delete('/api/users/:id', requireAuth(['superadmin']), (req, res) => {
  try { deleteUser(req.params.id); addLog({user:req.user,action:'delete_user',detail:`ลบ ${req.params.id}`}); res.json({ok:true}); }
  catch(e) { if(!res.headersSent) res.json({ok:false,error:e.message}); }
});

// ═══════════════════════════════════════════════════════════
// GPS
// ═══════════════════════════════════════════════════════════
const FASTAPI_URL = 'https://repair.mobile1234.site';
const FASTAPI_KEY = 'repair123';

app.post('/api/gps', requireAuth(), async (req, res) => {
  try {
    const { latitude, longitude, accuracy, ticket_id } = req.body || {};
    const lat = parseFloat(latitude), lng = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lng)) return res.json({ ok:false, error:'Missing coordinates' });
    const axios = require('axios');
    await axios.post(`${FASTAPI_URL}/api/gps`, {
      user_id: String(req.user.id), engineer_name: req.user.name, brand: req.user.brand || null,
      latitude: lat, longitude: lng, accuracy: accuracy ? parseFloat(accuracy) : null, ticket_id: ticket_id || null
    }, { headers: { 'X-API-Key': FASTAPI_KEY }, timeout: 8000 });
    broadcast('gps_updated', { user_id:req.user.id, engineer_name:req.user.name, latitude:lat, longitude:lng });
    res.json({ ok:true });
  } catch(e) { console.error('[GPS POST]', e.message); res.json({ ok:false, error:e.message }); }
});

app.get('/api/gps', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const r = await axios.get(`${FASTAPI_URL}/api/gps`, { headers: { 'X-API-Key': FASTAPI_KEY }, timeout: 8000 });
    res.json(r.data);
  } catch(e) { console.error('[GPS GET]', e.message); res.json({ ok:true, locations:[] }); }
});

app.get('/api/gps/history', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const params = {};
    if (req.query.engineer_name) params.engineer_name = req.query.engineer_name;
    if (req.query.user_id)       params.user_id       = req.query.user_id;
    if (req.query.date_from)     params.date_from     = req.query.date_from;
    if (req.query.date_to)       params.date_to       = req.query.date_to;
    if (req.query.session_id)    params.session_id    = req.query.session_id;
    if (req.query.limit)         params.limit         = Math.min(parseInt(req.query.limit)||2000, 5000);
    const r = await axios.get(`${FASTAPI_URL}/api/gps/history`, { headers: { 'X-API-Key': FASTAPI_KEY }, params, timeout: 15000 });
    res.json(r.data);
  } catch(e) { console.error('[GPS HISTORY]', e.message); res.json({ ok:false, error:e.message, points:[], sessions:[] }); }
});

app.get('/api/gps/sessions', requireAuth(['superadmin','admin','manager','it_services']), async (req, res) => {
  try {
    const axios = require('axios');
    const params = {};
    if (req.query.engineer_name) params.engineer_name = req.query.engineer_name;
    if (req.query.days) params.days = parseInt(req.query.days)||30;
    const r = await axios.get(`${FASTAPI_URL}/api/gps/sessions`, { headers: { 'X-API-Key': FASTAPI_KEY }, params, timeout: 10000 });
    res.json(r.data);
  } catch(e) { res.json({ ok:false, error:e.message, sessions:[] }); }
});

// ═══════════════════════════════════════════════════════════
// DEBUG
// ═══════════════════════════════════════════════════════════
app.get('/debug/gps', async (_, res) => {
  try {
    const axios = require('axios');
    const r = await axios.get(`${FASTAPI_URL}/api/gps`, { headers: { 'X-API-Key': FASTAPI_KEY }, timeout: 8000 });
    res.json({ ok:true, count:r.data.locations?.length||0, rows:r.data.locations });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.get('/debug/env', async (_, res) => {
  const adminGroup = await lineConfig.getAdminGroupId().catch(()=>'');
  res.json({
    hasLarkAppId:!!process.env.LARK_APP_ID, hasLarkSecret:!!process.env.LARK_APP_SECRET,
    hasLarkAppToken:!!process.env.LARK_APP_TOKEN, hasLarkTableId:!!process.env.LARK_TABLE_ID,
    hasLineToken:!!process.env.LINE_CHANNEL_ACCESS_TOKEN, hasLineSecret:!!process.env.LINE_CHANNEL_SECRET,
    hasLineAdminGroup:!!adminGroup,
    lineAdminGroup: adminGroup ? adminGroup.slice(0,10)+'...' : '(not set)',
    hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
    hasTelegramChat:  !!process.env.TELEGRAM_ADMIN_CHAT_ID,
    nodeEnv: process.env.NODE_ENV||'development',
    appUrl: process.env.APP_URL||'(not set)',
  });
});

app.get('/debug/rebuild-fieldmap', async (_,res) => {
  try { await ensureFieldMap(true); const d=await debugSchema(); res.json({ok:true,...d}); }
  catch(e) { if(!res.headersSent) res.json({ok:false,error:e.message}); }
});

app.get('/debug/tables', async (_,res) => {
  const { getToken } = require('./larkService');
  const axios = require('axios');
  const BASE='https://open.larksuite.com/open-apis', APP=process.env.LARK_APP_TOKEN;
  const tables=[
    {brand:"Dunkin'",tableId:process.env.LARK_TABLE_DUNKIN||process.env.LARK_TABLE_ID},
    {brand:"Greyhound Cafe",tableId:process.env.LARK_TABLE_GREYHOUND_CAFE},
    {brand:"Greyhound Original",tableId:process.env.LARK_TABLE_GREYHOUND_ORIGINAL||process.env.LARK_TABLE_GREYHOUND_ORI},
    {brand:"Au Bon Pain",tableId:process.env.LARK_TABLE_AU_BON_PAIN},
    {brand:"Funky Fries",tableId:process.env.LARK_TABLE_FUNKY_FRIES},
  ];
  try {
    const token=await getToken();
    const results=await Promise.allSettled(tables.map(async({brand,tableId})=>{
      if(!tableId)return{brand,status:'NO_ENV',count:0};
      const r=await axios.get(`${BASE}/bitable/v1/apps/${APP}/tables/${tableId}/records`,{headers:{Authorization:`Bearer ${token}`},params:{page_size:10},timeout:10000});
      return{brand,tableId,status:r.data.code===0?'OK':'ERROR',count:r.data.data?.total||0};
    }));
    res.json({ok:true,tables:results.map((r,i)=>r.status==='fulfilled'?r.value:{brand:tables[i].brand,error:r.reason?.message})});
  } catch(e){res.json({ok:false,error:e.message});}
});

app.get('/debug/test-line', async (_,res) => {
  const to = await lineConfig.getAdminGroupId().catch(()=>'');
  if (!to) return res.json({ ok:false, error:'No Admin Group ID set — go to Admin > LINE Settings' });
  const result = await lineNotify.push(to, [{ type:'text', text:'Test from IT Support Hub' }]);
  res.json(result);
});

app.get('/debug/test-telegram', async (_,res) => {
  const tg = require('./telegramService');
  const status = await tg.checkBotStatus();
  if (!status.ok) return res.json({ ok:false, error:'Bot offline: '+status.error });
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) return res.json({ ok:false, error:'No TELEGRAM_ADMIN_CHAT_ID set' });
  const result = await tg.sendMessage(chatId, '🧪 Test from IT Support Hub — Telegram OK');
  res.json({ ...result, botName: status.botName });
});

app.get('/debug/lark-fields', async (_,res) => {
  try { res.json({ok:true,...await debugSchema()}); } catch(e){res.json({ok:false,error:e.message});}
});

app.get('/debug/branches', (_,res) => {
  const tickets=global._debugTickets||[];
  const byBrand={};
  tickets.forEach(t=>{ if(!byBrand[t.brand||'?'])byBrand[t.brand||'?']=new Set(); if(t.branchCode)byBrand[t.brand||'?'].add(t.branchCode); });
  const result={};
  Object.entries(byBrand).forEach(([b,s])=>{result[b]=[...s].sort();});
  res.json({ok:true,total:tickets.length,branchCodes:result});
});

// ═══════════════════════════════════════════════════════════
// REPORTER SELF-SERVICE
// ═══════════════════════════════════════════════════════════
app.post('/api/reporter/change-password', requireAuth(['reporter']), async (req, res) => {
  try {
    const { old_password, new_password } = req.body || {};
    const user = req.user;
    if (!new_password || new_password.length < 6)
      return res.json({ ok:false, error:'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    try {
      const r = await axios.post(`${REPAIR_URL}/api/reporter/change-password`,
        { user_id: user.id, new_password, old_password: (old_password ?? null) },
        { headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type':'application/json' }, timeout: 30000 });
      if (!r.data?.ok) return res.json({ ok:false, error: r.data?.error || 'change failed' });
    } catch(apiErr) {
      const status = apiErr.response?.status;
      const detail = apiErr.response?.data?.detail;
      let msg;
      if (status === 401 || detail === 'รหัสผ่านเดิมไม่ถูกต้อง') msg = 'รหัสผ่านเดิมไม่ถูกต้อง';
      else if (status === 404 && (!detail || detail === 'Not Found')) msg = 'ระบบกำลังอัปเดต กรุณาลองอีกครั้งในอีก 1-2 นาที';
      else if (status === 404) msg = detail || 'ไม่พบบัญชีของคุณในระบบ';
      else msg = detail || apiErr.message || 'change failed';
      return res.json({ ok:false, error: msg });
    }
    addLog({ user, action:'change_password', detail:'Reporter เปลี่ยนรหัสผ่านด้วยตัวเอง' });
    res.json({ ok:true });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.post('/api/reporter/forgot-password', async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username) return res.json({ ok:false, error:'กรุณาระบุ username' });
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    let user = null;
    try {
      const r = await axios.post(`${REPAIR_URL}/api/reporter/forgot-password`,
        { username },
        { headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type':'application/json' }, timeout: 30000 });
      if (!r.data?.ok) return res.json({ ok:false, error: r.data?.error || 'ไม่พบบัญชีนี้ในระบบ' });
      user = r.data.user || null;
    } catch(apiErr) {
      const status = apiErr.response?.status;
      const msg = apiErr.response?.data?.detail || apiErr.message;
      if (status === 404) return res.json({ ok:false, error:'ไม่พบบัญชีนี้ในระบบ' });
      return res.json({ ok:false, error: msg || 'forgot-password failed' });
    }
    try {
      const adminGroupId = await lineConfig.getAdminGroupId();
      if (adminGroupId && user) {
        await lineNotify.push(adminGroupId, [{
          type: 'text',
          text: `🔑 [ลืมรหัสผ่าน]\nชื่อ: ${user.name||'-'}\nUsername: ${username}\nแบรนด์: ${user.brand || '-'}\n\nกรุณา Reset รหัสผ่านใน Admin Panel`
        }]);
      }
    } catch(lineErr) { console.warn('[ForgotPwd] LINE notify failed:', lineErr.message); }
    addLog({ user: user || { username }, action:'forgot_password', detail:`ขอ reset รหัสผ่าน` });
    res.json({ ok:true });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.post('/api/admin/reporter/reset-password', requireAuth(['superadmin','admin','it_services']), async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.json({ ok:false, error:'ต้องระบุ userId' });
    const axios = require('axios');
    const REPAIR_URL = process.env.REPAIR_API_URL || 'http://repair.mobile1234.site';
    const REPAIR_KEY = process.env.REPAIR_API_KEY || 'repair123';
    let result;
    try {
      const r = await axios.post(`${REPAIR_URL}/api/admin/reporter/reset-password`,
        { user_id: userId, reset_by: req.user?.username || 'admin' },
        { headers: { 'X-API-Key': REPAIR_KEY, 'Content-Type':'application/json' }, timeout: 30000 });
      if (!r.data?.ok) return res.json({ ok:false, error: r.data?.error || 'reset failed' });
      result = r.data;
    } catch(apiErr) {
      const status = apiErr.response?.status;
      const msg = apiErr.response?.data?.detail || apiErr.message;
      if (status === 404) return res.json({ ok:false, error:'ไม่พบ reporter' });
      return res.json({ ok:false, error: msg || 'reset failed' });
    }
    addLog({ user: req.user, action:'reset_reporter_password', detail: `Reset รหัสผ่าน ${result.user?.username||userId}` });
    res.json({ ok:true, default_password: result.default_password });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

app.get('/api/admin/reporters', requireAuth(['superadmin','admin','manager','it_services']), (req, res) => {
  try {
    const all = getAllReporters();
    const { brand, search } = req.query;
    let list = all;
    if (brand) list = list.filter(r => r.brand === brand);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r => r.name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q));
    }
    res.json({ ok:true, reporters: list, total: list.length });
  } catch(e) { if(!res.headersSent) res.json({ ok:false, error:e.message }); }
});

// ── Telegram Webhook (รับ !groupid command) ────────────────
app.post('/telegram/webhook', express.json(), async (req, res) => {
  try {
    await require('./telegramService').handleWebhook(req.body);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── Webhooks ─────────────────────────────────────────────────
app.use('/lark', larkRouter);
app.use('/line', lineRouter);

// ── Startup ─────────────────────────────────────────────────

// ── ตั้ง Telegram Webhook ตอน startup ──────────────────────
setTimeout(async () => {
  try {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const appUrl = process.env.APP_URL || 'https://it-service-56im.onrender.com';
    if (token) {
      const axios = require('axios');
      const r = await axios.post(`https://api.telegram.org/bot${token}/setWebhook`, {
        url: `${appUrl}/telegram/webhook`,
        allowed_updates: ['message']
      }, { timeout: 8000 });
      console.log('[TG] Webhook set:', appUrl + '/telegram/webhook', r.data?.ok);
    }
  } catch(e) { console.warn('[TG] setWebhook failed:', e.message); }
}, 5000);

setTimeout(async () => {
  try { await ensureFieldMap(); console.log('[App] fieldMap ready'); } catch(e) { console.warn('[App]',e.message); }
}, 3000);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime: process.uptime() });
});

module.exports = app;
