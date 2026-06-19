const express   = require('express');
const cors      = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs        = require('fs');
const path      = require('path');
const http      = require('http');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');

// Load .env
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

const app    = express();
const PORT   = process.env.PORT || 3000;
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// WebSocket: map token → {ws, businessId}
const wsClients = new Map();

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token') || '';
  const users = readUsers();
  const user  = users.find(u => u.token === token);
  if (!user) { ws.close(); return; }

  wsClients.set(token, { ws, businessId: user.businessId });

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

  ws.on('close', () => { wsClients.delete(token); clearInterval(ping); });
  ws.on('error', () => { wsClients.delete(token); clearInterval(ping); });
});

function broadcast(businessId, payload) {
  const msg = JSON.stringify(payload);
  wsClients.forEach(({ ws, businessId: bid }) => {
    if (bid === businessId && ws.readyState === WebSocket.OPEN)
      ws.send(msg);
  });
}
const DATA_DIR       = path.join(__dirname, 'data');
const BOOKINGS_FILE  = path.join(DATA_DIR, 'bookings.json');
const MENU_FILE      = path.join(DATA_DIR, 'menu.json');
const USERS_FILE     = path.join(DATA_DIR, 'users.json');
const CONFIG_FILE    = path.join(DATA_DIR, 'config.json');
const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');
const PACKAGES_FILE  = path.join(DATA_DIR, 'packages.json');
const FEEDBACK_FILE  = path.join(DATA_DIR, 'feedback.json');

// Owner contact — receives all feedback SMS
const OWNER_PHONE = '+972555648787';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded bodies
app.use(express.static(path.join(__dirname, 'public')));

// ── Fixed table definitions ──────────────────────────────────────────
const TABLES = [
  { id: 1,  capacity: 2, area: 'פנים' },
  { id: 2,  capacity: 2, area: 'פנים' },
  { id: 3,  capacity: 4, area: 'פנים' },
  { id: 4,  capacity: 4, area: 'פנים' },
  { id: 5,  capacity: 4, area: 'פנים' },
  { id: 6,  capacity: 6, area: 'פנים' },
  { id: 7,  capacity: 2, area: 'פנים' },
  { id: 8,  capacity: 4, area: 'פנים' },
  { id: 9,  capacity: 4, area: 'פנים' },
  { id: 10, capacity: 6, area: 'פנים' },
  { id: 11, capacity: 2, area: 'חוץ'  },
  { id: 12, capacity: 2, area: 'חוץ'  },
  { id: 13, capacity: 4, area: 'חוץ'  },
  { id: 14, capacity: 4, area: 'חוץ'  },
];

// ── File helpers ──────────────────────────────────────────────────────
function readJSON(file, def = []) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(def, null, 2), 'utf8');
    return def;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
const readBookings   = () => readJSON(BOOKINGS_FILE, []);
const writeBookings  = d  => writeJSON(BOOKINGS_FILE, d);
const readUsers      = () => readJSON(USERS_FILE, []);
const writeUsers     = d  => writeJSON(USERS_FILE, d);
const readInventory  = () => readJSON(INVENTORY_FILE, []);
const writeInventory = d  => writeJSON(INVENTORY_FILE, d);
const readPackages   = () => readJSON(PACKAGES_FILE, []);
const writePackages  = d  => writeJSON(PACKAGES_FILE, d);
const readConfig    = () => readJSON(CONFIG_FILE, { stripeSecretKey:'', stripePublishableKey:'', twilioAccountSid:'', twilioAuthToken:'', twilioFromNumber:'' });
const writeConfig   = d  => writeJSON(CONFIG_FILE, d);

// ── Auth middleware ───────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = readUsers().find(u => u.token === token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────
app.get('/api/auth/verify', (req, res) => {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ valid: false });
  const user = readUsers().find(u => u.token === token);
  if (!user) return res.status(401).json({ valid: false });
  const { password: _, ...safe } = user;
  res.json({ valid: true, user: safe });
});

app.post('/api/auth/register', (req, res) => {
  const { email, password, businessName, businessType, businessPhone } = req.body;
  if (!email || !password || !businessName || !businessType || !businessPhone)
    return res.status(400).json({ error: 'Required fields missing' });

  const users = readUsers();

  // Block duplicate signups (anti free-trial abuse): same email, phone, or business
  // name can only register once.
  const emailNorm = email.trim().toLowerCase();
  const phoneNorm = businessPhone ? normalizeNumber(businessPhone) : '';
  const bizNorm   = businessName.trim().toLowerCase();

  if (users.find(u => (u.email || '').toLowerCase() === emailNorm))
    return res.status(409).json({ error: 'This email is already registered' });

  if (phoneNorm && users.find(u => u.businessPhone && normalizeNumber(u.businessPhone) === phoneNorm))
    return res.status(409).json({ error: 'This phone number is already registered' });

  if (users.find(u => (u.businessName || '').trim().toLowerCase() === bizNorm))
    return res.status(409).json({ error: 'A business with this name is already registered' });

  const user = {
    id:           uuidv4(),
    email:        email.toLowerCase(),
    password,
    businessId:   uuidv4(),
    businessName,
    businessType: 'restaurant',
    businessPhone: businessPhone || '',
    voiceCode:    genVoiceCode(new Set(users.map(u => u.voiceCode).filter(Boolean))),
    plan:         'trial',
    trialEnds:    new Date(Date.now() + 0).toISOString(),
    token:        uuidv4(),
    createdAt:    new Date().toISOString(),
    freeAd:       { used: false, text: '', active: false },
    bookingQuestions: [
      'How many guests will be dining?',
      'What date would you like to book?',
      'What time would you prefer?',
      'Any dietary restrictions or allergies?',
      'Any special requests or occasions?'
    ]
  };
  users.push(user);
  writeUsers(users);
  const { password: _, ...safe } = user;
  res.status(201).json(safe);
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Required fields missing' });

  const user = readUsers().find(
    u => u.email.toLowerCase() === email.toLowerCase() && u.password === password
  );
  if (!user) return res.status(401).json({ error: 'Wrong email or password' });
  const { password: _, ...safe } = user;
  res.json(safe);
});

app.get('/api/auth/me', auth, (req, res) => {
  const { password: _, ...safe } = req.user;
  res.json(safe);
});

// ── Bookings ─────────────────────────────────────────────────────────
app.get('/api/bookings', auth, (req, res) => {
  let list = readBookings().filter(b => b.businessId === req.user.businessId);
  const { date, status } = req.query;
  if (date)   list = list.filter(b => b.date === date);
  if (status) list = list.filter(b => b.status === status);
  list.sort((a, b) => a.date !== b.date
    ? a.date.localeCompare(b.date)
    : a.time.localeCompare(b.time));
  res.json(list);
});

app.get('/api/bookings/:id', auth, (req, res) => {
  const b = readBookings().find(
    b => b.id === req.params.id && b.businessId === req.user.businessId
  );
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  res.json(b);
});

app.post('/api/bookings', auth, (req, res) => {
  const { name, phone, date, time, guests, notes, transcript, source, table, preferredArea, checkOut, roomType } = req.body;
  if (!name || !phone || !date || !time || !guests)
    return res.status(400).json({ error: 'Required fields missing' });

  const list = readBookings();
  const booking = {
    id:         uuidv4(),
    businessId: req.user.businessId,
    name, phone, date, time,
    guests:     parseInt(guests),
    table:      table ? parseInt(table) : null,
    notes:         notes || '',
    preferredArea: preferredArea || null,
    checkOut:      checkOut || null,
    roomType:      roomType || null,
    status:        'confirmed',
    source:     source || 'manual',
    transcript: transcript || [],
    createdAt:  new Date().toISOString()
  };
  list.push(booking);
  writeBookings(list);
  broadcast(req.user.businessId, { type: 'booking:new', booking });
  res.status(201).json(booking);
});

app.patch('/api/bookings/:id', auth, (req, res) => {
  const list  = readBookings();
  const index = list.findIndex(
    b => b.id === req.params.id && b.businessId === req.user.businessId
  );
  if (index === -1) return res.status(404).json({ error: 'Booking not found' });
  list[index] = { ...list[index], ...req.body };
  writeBookings(list);
  broadcast(req.user.businessId, { type: 'booking:updated', booking: list[index] });
  res.json(list[index]);
});

app.delete('/api/bookings/:id', auth, (req, res) => {
  const list  = readBookings();
  const index = list.findIndex(
    b => b.id === req.params.id && b.businessId === req.user.businessId
  );
  if (index === -1) return res.status(404).json({ error: 'Booking not found' });
  const deleted = list[index];
  list.splice(index, 1);
  writeBookings(list);
  broadcast(req.user.businessId, { type: 'booking:deleted', id: deleted.id });
  res.json({ message: 'Deleted' });
});

// ── Stats ─────────────────────────────────────────────────────────────
app.get('/api/stats', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  if (req.user.businessType === 'warehouse') {
    const pkgs = readPackages().filter(p => p.businessId === req.user.businessId);
    return res.json({
      waiting:       pkgs.filter(p => p.status === 'waiting').length,
      pickedUpToday: pkgs.filter(p => p.status === 'pickedUp' && (p.pickedUpAt||'').startsWith(today)).length,
      arrivedToday:  pkgs.filter(p => (p.arrivedAt||'').startsWith(today)).length,
      overdue:       pkgs.filter(p => p.status === 'waiting' && Math.floor((Date.now() - new Date(p.arrivedAt)) / 864e5) >= 14).length,
      total:         pkgs.length
    });
  }

  const list = readBookings().filter(b => b.businessId === req.user.businessId);

  if (req.user.businessType === 'hotel') {
    const active   = list.filter(b => b.status !== 'cancelled');
    const occupied = active.filter(b => b.date <= today && (b.checkOut || b.date) >= today).length;
    return res.json({
      total:          list.length,
      occupied,
      checkinsToday:  active.filter(b => b.date === today).length,
      checkoutsToday: active.filter(b => b.checkOut === today).length,
      totalGuests:    active.reduce((s, b) => s + (b.guests || 0), 0)
    });
  }

  res.json({
    total:       list.length,
    today:       list.filter(b => b.date === today).length,
    confirmed:   list.filter(b => b.status === 'confirmed').length,
    pending:     list.filter(b => b.status === 'pending').length,
    cancelled:   list.filter(b => b.status === 'cancelled').length,
    totalGuests: list.filter(b => b.status === 'confirmed').reduce((s, b) => s + b.guests, 0),
    fromPhone:   list.filter(b => b.source === 'phone').length
  });
});

// ── Menu ─────────────────────────────────────────────────────────────
app.get('/api/menu', auth, (req, res) => {
  res.json(JSON.parse(fs.readFileSync(MENU_FILE, 'utf8')));
});

// Public menu (no auth — used by QR code)
app.get('/api/menu-public/:businessId', (req, res) => {
  const users = readUsers();
  const user  = users.find(u => u.businessId === req.params.businessId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const menu = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
  res.json({ businessName: user.businessName, businessType: user.businessType, freeAd: user.freeAd || null, menu });
});

// ── Tables ────────────────────────────────────────────────────────────
app.get('/api/tables', auth, (req, res) => {
  const { date } = req.query;
  const list = readBookings().filter(b => b.businessId === req.user.businessId);
  const dayBookings = date
    ? list.filter(b => b.date === date && b.status !== 'cancelled')
    : [];

  const bookedTableIds = new Set(dayBookings.map(b => b.table).filter(Boolean));
  const tables = TABLES.map(t => ({
    ...t,
    status:  bookedTableIds.has(t.id) ? 'booked' : 'free',
    booking: dayBookings.find(b => b.table === t.id) || null
  }));
  res.json(tables);
});

// ── Analytics ────────────────────────────────────────────────────────
app.get('/api/analytics', auth, (req, res) => {
  const list = readBookings().filter(b => b.businessId === req.user.businessId);
  const menu = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));

  const prices = {};
  menu.categories.forEach(cat =>
    cat.items.forEach(item => { prices[item.id] = item.price; })
  );

  // Last 14 days
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayBks  = list.filter(b => b.date === dateStr && b.status !== 'cancelled');
    days.push({
      date:   dateStr,
      label:  d.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' }),
      count:  dayBks.length,
      guests: dayBks.reduce((s, b) => s + b.guests, 0)
    });
  }

  // By hour 12–23
  const byHour = {};
  for (let h = 12; h <= 23; h++) byHour[h] = 0;
  list.filter(b => b.status !== 'cancelled').forEach(b => {
    const h = parseInt(b.time.split(':')[0]);
    if (byHour[h] !== undefined) byHour[h]++;
  });

  // Revenue
  let revenue = 0;
  list.filter(b => b.status !== 'cancelled' && b.orders?.length).forEach(b => {
    b.orders.forEach(o => { if (prices[o.itemId]) revenue += prices[o.itemId] * o.qty; });
  });

  const active     = list.filter(b => b.status !== 'cancelled');
  const fromPhone  = active.filter(b => b.source === 'phone').length;
  const fromManual = active.filter(b => b.source !== 'phone').length;
  const topHour    = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
  const avgGuests  = active.length
    ? (active.reduce((s, b) => s + b.guests, 0) / active.length).toFixed(1)
    : 0;

  const phoneCounts = {};
  list.forEach(b => { phoneCounts[b.phone] = (phoneCounts[b.phone] || 0) + 1; });
  const returning = Object.values(phoneCounts).filter(c => c > 1).length;

  // Hotel: avg nights
  let avgNights = null;
  if (req.user.businessType === 'hotel') {
    const withNights = active.filter(b => b.date && b.checkOut);
    if (withNights.length) {
      const totalNights = withNights.reduce((s, b) =>
        s + Math.max(0, Math.round((new Date(b.checkOut) - new Date(b.date)) / 864e5)), 0);
      avgNights = (totalNights / withNights.length).toFixed(1);
    }
  }

  res.json({ days, byHour, revenue, fromPhone, fromManual, topHour, avgGuests, returning,
             total: list.length, cancelled: list.filter(b=>b.status==='cancelled').length, avgNights });
});

// ── Payment ───────────────────────────────────────────────────────────
// Basic $1k · Advanced $5k (better 2D map + more) · Enterprise $10k (3D map + all)
const PLAN_PRICES = {
  pro_intro: 10000,
  pro: 100000,     pro_annual: 1000000,
  network: 500000, network_annual: 5000000,
  enterprise_plus: 1000000, enterprise_plus_annual: 10000000
};

// Max seconds per individual call
const CALL_DURATION_SEC = {
  demo: 60, trial: 60, pro_intro: 60, pro: 60, pro_annual: 60,
  network: 60, network_annual: 60,
  enterprise_plus: 60, enterprise_plus_annual: 60,
};

// Monthly call budget in minutes
const CALL_BUDGET_MIN = {
  demo: Infinity, trial: 10,
  pro_intro: 100,
  pro: 1000,       pro_annual: 12000,
  network: 5000,   network_annual: 60000,
  enterprise_plus: 10000, enterprise_plus_annual: 120000,
};

// All plans = 1 location (no multi-business tiers)
const LOCATION_LIMIT = {
  demo: 1, trial: 1, pro_intro: 1, pro: 1, pro_annual: 1,
  network: 1, network_annual: 1,
  enterprise_plus: 1, enterprise_plus_annual: 1,
};

function getCallBudget(user) {
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const cm    = user.callMinutes || { used: 0, month: '' };
  const used  = cm.month === month ? (cm.used || 0) : 0;
  const limit = CALL_BUDGET_MIN[user.plan] ?? 0;
  return { used, month, limit, remaining: limit === Infinity ? Infinity : Math.max(0, limit - used) };
}

function deductCallMinute(user) {
  const budget = getCallBudget(user);
  const users  = readUsers();
  const idx    = users.findIndex(u => u.id === user.id);
  if (idx !== -1) {
    users[idx].callMinutes = { used: budget.used + 1, month: budget.month };
    writeUsers(users);
  }
}

// Return publishable key to frontend (safe to expose)
app.get('/api/payment/config', (req, res) => {
  const cfg = readConfig();
  res.json({ publishableKey: cfg.stripePublishableKey || '' });
});

// Admin: save Stripe keys
app.patch('/api/payment/config', (req, res) => {
  const cfg = readConfig();
  if (req.body.stripeSecretKey)      cfg.stripeSecretKey      = req.body.stripeSecretKey;
  if (req.body.stripePublishableKey) cfg.stripePublishableKey = req.body.stripePublishableKey;
  writeConfig(cfg);
  res.json({ ok: true });
});

// Charge via Stripe
app.post('/api/payment/charge', auth, async (req, res) => {
  const { paymentMethodId, plan } = req.body;
  const cfg = readConfig();

  if (!cfg.stripeSecretKey)
    return res.status(400).json({ error: 'Stripe not configured on server' });
  if (!PLAN_PRICES[plan])
    return res.status(400).json({ error: 'Invalid plan' });

  try {
    const stripeReq = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.stripeSecretKey}`,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        amount:               String(PLAN_PRICES[plan]),
        currency:             'ils',
        payment_method:       paymentMethodId,
        confirm:              'true',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never'
      })
    });

    const intent = await stripeReq.json();
    if (intent.status !== 'succeeded')
      return res.status(400).json({ error: `Payment failed: ${intent.last_payment_error?.message || intent.status}` });

    // Activate plan (pro_intro grants pro-level access)
    const activePlan = plan === 'pro_intro' ? 'pro' : plan;
    const users = readUsers();
    const idx   = users.findIndex(u => u.token === req.user.token);
    if (idx !== -1) { users[idx].plan = activePlan; users[idx].paidAt = new Date().toISOString(); }
    writeUsers(users);
    res.json({ ok: true, plan: activePlan });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Mock activate (no Stripe — dev mode)
app.post('/api/payment/activate', auth, (req, res) => {
  const { plan } = req.body;
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan' });
  const activePlan = plan === 'pro_intro' ? 'pro' : plan;
  const users = readUsers();
  const idx   = users.findIndex(u => u.token === req.user.token);
  if (idx !== -1) { users[idx].plan = activePlan; users[idx].paidAt = new Date().toISOString(); }
  writeUsers(users);
  res.json({ ok: true, plan });
});

// ── User settings (API key etc.) ─────────────────────────────────────
app.patch('/api/auth/settings', auth, (req, res) => {
  const users = readUsers();
  const idx   = users.findIndex(u => u.token === req.user.token);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const allowed = ['claudeApiKey', 'businessName', 'businessPhone', 'businessAddress',
                   'welcomeMessage', 'businessHours', 'maxCapacity', 'slotDuration', 'advanceDays',
                   'freeAd', 'bookingQuestions', 'callDuration', 'forwardNumber'];
  allowed.forEach(k => { if (req.body[k] !== undefined) users[idx][k] = req.body[k]; });
  writeUsers(users);
  const { password: _, ...safe } = users[idx];
  res.json(safe);
});

// ── Usage stats ──────────────────────────────────────────────────────
app.get('/api/auth/usage', auth, (req, res) => {
  const budget   = getCallBudget(req.user);
  const locLimit = LOCATION_LIMIT[req.user.plan] ?? 1;
  res.json({
    callMinutes:    { used: budget.used, limit: budget.limit, remaining: budget.remaining, month: budget.month },
    locationLimit:  locLimit,
    plan:           req.user.plan,
  });
});

// ── AI map generation via Claude Vision ──────────────────────────────
app.post('/api/generate-map', auth, async (req, res) => {
  const { images } = req.body;
  const apiKey = req.user.claudeApiKey || process.env.ANTHROPIC_API_KEY;

  if (!apiKey)
    return res.status(400).json({ error: 'AI is not configured on the server.' });
  if (!images?.length)
    return res.status(400).json({ error: 'No images uploaded' });

  const content = [
    ...images.slice(0, 8).map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img }
    })),
    {
      type: 'text',
      text: `You are analyzing photos of a business interior to generate a 3D floor plan.

Identify all tables/seating, bar, kitchen, bathrooms, entrance, terrace areas.

Return ONLY valid JSON in exactly this format (no extra text):
{
  "tables": [
    {"id": 1, "x": -5.5, "z": 2.5, "capacity": 4, "area": "פנים"},
    {"id": 2, "x": -3.5, "z": 2.5, "capacity": 2, "area": "פנים"}
  ],
  "elements": {
    "hasKitchen": true,
    "hasBar": false,
    "hasTerrace": false
  }
}

Rules:
- x range: -8 (left) to 8 (right). z range: -5 (back) to 5 (front)
- capacity: 2, 4, or 6 only
- area: "פנים" (indoor) or "חוץ" (outdoor/terrace)
- terrace tables: x range 10-14
- Identify 4–20 tables total
- Space tables at least 2 units apart`
    }
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
        'content-type':       'application/json'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 2048,
        messages:   [{ role: 'user', content }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(400).json({
        error: `Claude API error: ${err.error?.message || response.status}`
      });
    }

    const data  = await response.json();
    const text  = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Claude did not return valid JSON' });

    res.json(JSON.parse(match[0]));
  } catch (e) {
    res.status(500).json({ error: `Error: ${e.message}` });
  }
});

// ── Export CSV (Excel-compatible with BOM) ────────────────────────────
app.get('/api/export/csv', auth, (req, res) => {
  const list = readBookings().filter(b => b.businessId === req.user.businessId);
  const STATUS_MAP = { confirmed: 'Confirmed', pending: 'Pending', cancelled: 'Cancelled' };
  const SOURCE_MAP = { phone: 'Phone', manual: 'Manual', online: 'Online' };

  const headers = ['ID','Name','Phone','Date','Time','Guests','Table','Status','Source','Notes'];
  const rows = list.map(b => [
    b.id, b.name, b.phone, b.date, b.time, b.guests,
    b.table || '', STATUS_MAP[b.status] || b.status,
    SOURCE_MAP[b.source] || b.source, (b.notes || '').replace(/,/g, '،')
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const biz = req.user.businessName.replace(/[^a-zA-Z0-9]/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${biz}_bookings.csv"`);
  res.send('﻿' + csv); // BOM for Hebrew in Excel
});

// ── Export print page ─────────────────────────────────────────────────
app.get('/api/export/print', auth, (req, res) => {
  const list = readBookings().filter(b => b.businessId === req.user.businessId);
  const STATUS_MAP  = { confirmed: 'Confirmed', pending: 'Pending', cancelled: 'Cancelled' };
  const STATUS_CLR  = { confirmed: '#22c55e', pending: '#f59e0b', cancelled: '#ef4444' };
  const today = new Date().toLocaleDateString('en-US');
  const biz   = req.user.businessName;

  const rows = list.map(b => `
    <tr>
      <td>${b.name}</td>
      <td dir="ltr">${b.phone}</td>
      <td>${b.date}</td>
      <td>${b.time}</td>
      <td>${b.guests}</td>
      <td>${b.table || '-'}</td>
      <td style="color:${STATUS_CLR[b.status] || '#fff'};font-weight:600">${STATUS_MAP[b.status] || b.status}</td>
      <td>${b.notes || ''}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Bookings — ${biz}</title>
  <style>
    body{font-family:Arial,sans-serif;padding:24px;color:#111;}
    h1{font-size:1.4rem;margin-bottom:4px;}
    .meta{font-size:.85rem;color:#555;margin-bottom:20px;}
    table{width:100%;border-collapse:collapse;font-size:.82rem;}
    th{background:#1a1d2a;color:#fff;padding:8px 10px;text-align:left;border:1px solid #333;}
    td{padding:7px 10px;border:1px solid #ddd;}
    tr:nth-child(even) td{background:#f7f8fa;}
    @media print{body{padding:0}}
  </style>
</head>
<body>
  <h1>Bookings — ${biz}</h1>
  <div class="meta">Generated: ${today} · Total ${list.length} bookings</div>
  <table>
    <thead><tr>
      <th>Name</th><th>Phone</th><th>Date</th><th>Time</th>
      <th>Guests</th><th>Table</th><th>Status</th><th>Notes</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>window.onload=()=>{window.print();}<\/script>
</body>
</html>`);
});

// ── Inventory ─────────────────────────────────────────────────────────
app.get('/api/inventory', auth, (req, res) => {
  res.json(readInventory().filter(i => i.businessId === req.user.businessId));
});

app.post('/api/inventory', auth, (req, res) => {
  const { name, category, quantity, minQuantity, unit } = req.body;
  if (!name) return res.status(400).json({ error: 'Item name required' });
  const items = readInventory();
  const item  = {
    id: uuidv4(), businessId: req.user.businessId,
    name, category: category || 'General',
    quantity: parseInt(quantity) || 0,
    minQuantity: parseInt(minQuantity) || 0,
    unit: unit || 'unit',
    createdAt: new Date().toISOString()
  };
  items.push(item); writeInventory(items);
  res.status(201).json(item);
});

app.patch('/api/inventory/:id', auth, (req, res) => {
  const items = readInventory();
  const idx   = items.findIndex(i => i.id === req.params.id && i.businessId === req.user.businessId);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });
  items[idx] = { ...items[idx], ...req.body };
  writeInventory(items);
  res.json(items[idx]);
});

app.delete('/api/inventory/:id', auth, (req, res) => {
  const items = readInventory();
  const idx   = items.findIndex(i => i.id === req.params.id && i.businessId === req.user.businessId);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });
  items.splice(idx, 1); writeInventory(items);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// AI VOICE CONVERSATION SYSTEM (Claude + Twilio)
// Webhook URL: POST /api/voice/:token
// ══════════════════════════════════════════════════════════════

// Active call sessions (in-memory, cleared on hangup)
const callSessions = new Map();

// Language → best Polly voice mapping
const LANG_VOICE = {
  'en':'Polly.Joanna-Neural','en-US':'Polly.Joanna-Neural','en-GB':'Polly.Amy-Neural',
  'es':'Polly.Lupe-Neural','es-US':'Polly.Lupe-Neural','es-ES':'Polly.Conchita',
  'fr':'Polly.Celine','fr-FR':'Polly.Celine','fr-CA':'Polly.Chantal',
  'de':'Polly.Vicki-Neural','de-DE':'Polly.Vicki-Neural',
  'it':'Polly.Bianca-Neural','it-IT':'Polly.Bianca-Neural',
  'pt':'Polly.Camila-Neural','pt-BR':'Polly.Camila-Neural','pt-PT':'Polly.Ines',
  'ja':'Polly.Mizuki','ja-JP':'Polly.Mizuki',
  'ko':'Polly.Seoyeon','ko-KR':'Polly.Seoyeon',
  'zh':'Polly.Zhiyu','cmn-CN':'Polly.Zhiyu',
  'ar':'Polly.Zeina','ar-SA':'Polly.Zeina',
  'ru':'Polly.Tatyana','ru-RU':'Polly.Tatyana',
  'nl':'Polly.Lotte','nl-NL':'Polly.Lotte',
  'pl':'Polly.Ewa','pl-PL':'Polly.Ewa',
  'sv':'Polly.Astrid','sv-SE':'Polly.Astrid',
  'tr':'Polly.Filiz','tr-TR':'Polly.Filiz',
  'hi':'Polly.Aditi','hi-IN':'Polly.Aditi',
  'he':'Polly.Joanna-Neural', // no Hebrew Polly, use English
};

function voiceFor(lang) {
  return LANG_VOICE[lang] || LANG_VOICE[lang?.split('-')[0]] || 'Polly.Joanna-Neural';
}

function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function gatherXml(sayText, voice, actionUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="5" enhanced="true">
    <Say voice="${voice}">${xmlEsc(sayText)}</Say>
  </Gather>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="5">
    <Say voice="${voice}">${xmlEsc(sayText)}</Say>
  </Gather>
  <Hangup/>
</Response>`;
}

// ══════════════════════════════════════════════════════════════
// MULTI-TENANT routes — registered BEFORE the legacy /:token route
// because Express ":token" greedily matches any single segment
// (e.g. "incoming", "businesses"). Implementations live further down.
// ══════════════════════════════════════════════════════════════

// Start a call session for a business and return the greeting TwiML.
function beginCall(user, callSid, from) {
  incomingSessions.set(callSid, {
    callId:    uuidv4(),
    user,
    business:  { id: user.businessId, name: user.businessName || 'the restaurant' },
    caller:    from || 'unknown',
    history:   [],
    voice:     'Polly.Joanna-Neural',
    createdAt: new Date().toISOString()
  });
  saveCall(incomingSessions.get(callSid));
  const greeting = `תודה שהתקשרת ל${user.businessName || 'מסעדה'}. אני המארח החכם — איך אפשר לעזור?`;
  return gatherXml(greeting, 'Polly.Joanna-Neural', `/api/voice/incoming/respond?sid=${callSid}`);
}

// 1. Incoming call. TWO modes (hybrid):
//    a) The dialed number is a restaurant's OWN dedicated number → connect
//       directly, answer by name, NO code.
//    b) The dialed number is the shared line → ask for the 6-digit code.
app.post('/api/voice/incoming', (req, res) => {
  res.set('Content-Type', 'text/xml');
  const dialed        = normalizeNumber(req.body.To || '');
  const forwardedFrom = normalizeNumber(req.body.ForwardedFrom || '');
  const callSid       = req.body.CallSid || uuidv4();
  const users         = readUsers();

  // Log everything Twilio tells us — this is how we verify ForwardedFrom works.
  console.log(`[voice] incoming  From=${req.body.From || '?'}  To=${dialed}  ForwardedFrom=${forwardedFrom || '(none)'}`);

  // (a) Call FORWARDED from a restaurant's own number → identify by that number.
  //     This lets many restaurants share ONE Twilio line: each forwards its
  //     existing phone here, and Twilio tells us which number forwarded it.
  const byForward = forwardedFrom && users.find(u =>
    (u.forwardNumber && normalizeNumber(u.forwardNumber) === forwardedFrom) ||
    (u.businessPhone && normalizeNumber(u.businessPhone) === forwardedFrom));
  if (byForward) {
    console.log(`[voice] forwarded from ${forwardedFrom} → "${byForward.businessName}" (their own number)`);
    return res.send(beginCall(byForward, callSid, req.body.From));
  }

  // (b) Dialed number is a restaurant's dedicated Twilio number → connect directly.
  const owner = users.find(u => u.dedicatedNumber && normalizeNumber(u.dedicatedNumber) === dialed);
  if (owner) {
    console.log(`[voice] direct dial → "${owner.businessName}" (no code)`);
    return res.send(beginCall(owner, callSid, req.body.From));
  }

  // (c) Shared line, no forwarding info → ask for the 6-digit code.
  console.log(`[voice] shared line — asking for code`);
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="6" action="/api/voice/incoming/select" method="POST" timeout="8">
    <Say voice="Polly.Joanna-Neural">ברוכים הבאים לריזרב איי איי. אנא הקישו את הקוד בן שש הספרות של העסק אליו אתם מתקשרים.</Say>
  </Gather>
  <Say voice="Polly.Joanna-Neural">מצטערים, לא קיבלנו קוד. להתראות!</Say>
  <Hangup/>
</Response>`);
});

// 2. Map the entered code → business, greet AS that business, start talking.
app.post('/api/voice/incoming/select', (req, res) => {
  res.set('Content-Type', 'text/xml');
  const code    = (req.body.Digits || '').trim();
  const callSid = req.body.CallSid || uuidv4();
  const user    = readUsers().find(u => u.voiceCode === code);

  if (!user) {
    console.warn(`[voice] no business for code ${code}`);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="6" action="/api/voice/incoming/select" method="POST" timeout="8">
    <Say voice="Polly.Joanna-Neural">הקוד לא נמצא. אנא נסו שוב.</Say>
  </Gather>
  <Say voice="Polly.Joanna-Neural">להתראות!</Say>
  <Hangup/>
</Response>`);
  }

  console.log(`[voice] code ${code} → "${user.businessName}"`);
  res.send(beginCall(user, callSid, req.body.From));
});

// Owner's dashboard reads this: the AI line to forward to, their own number, and code.
app.get('/api/voice/my-line', auth, (req, res) => {
  res.json({
    sharedNumber:  TWILIO_NUMBER_POOL[0],
    code:          req.user.voiceCode || null,
    forwardNumber: req.user.forwardNumber || req.user.businessPhone || ''
  });
});

// Admin: list businesses + which pool number each owns.
app.get('/api/voice/businesses', (req, res) => {
  const businesses = readBusinesses();
  res.json({
    businesses,
    pool: TWILIO_NUMBER_POOL.map(n => ({
      number:     normalizeNumber(n),
      assignedTo: businesses.find(b => normalizeNumber(b.twilio_number) === normalizeNumber(n))?.name || null
    }))
  });
});

// Admin: the calls log (transcripts).
app.get('/api/voice/calls', (req, res) => res.json(readCalls()));

// Admin: assign a pool number to a (new) business.
app.post('/api/voice/businesses', (req, res) => {
  const { name, twilio_number, system_prompt } = req.body;
  if (!name || !twilio_number)
    return res.status(400).json({ error: 'name and twilio_number are required' });

  const number = normalizeNumber(twilio_number);
  if (!TWILIO_NUMBER_POOL.map(normalizeNumber).includes(number))
    return res.status(400).json({ error: 'That number is not in the Twilio pool' });

  const list = readBusinesses();
  if (list.some(b => normalizeNumber(b.twilio_number) === number))
    return res.status(409).json({ error: 'That number is already assigned' });

  const business = {
    id:            uuidv4(),
    name,
    twilio_number: number,
    system_prompt: system_prompt || `You are the AI phone host for "${name}". Answer warmly, keep replies short, and reply in the caller's language.`,
    created_at:    new Date().toISOString()
  };
  list.push(business);
  writeBusinesses(list);
  res.status(201).json(business);
});

// 3. Conversation turn: Claude answers using the owner's configured questions,
//    logs the transcript, and creates a booking when details are confirmed.
app.post('/api/voice/incoming/respond', async (req, res) => {
  res.set('Content-Type', 'text/xml');

  const callSid = req.query.sid || req.body.CallSid;
  const speech  = (req.body.SpeechResult || '').trim();
  const lang    = req.body.LanguageCode || 'en-US';
  const session = incomingSessions.get(callSid);

  if (!session) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">מצטערים, השיחה פגה. אנא התקשרו שוב.</Say><Hangup/></Response>`);
  }

  const actionUrl = `/api/voice/incoming/respond?sid=${callSid}`;
  session.voice = voiceFor(lang);

  if (!speech) {
    return res.send(gatherXml("סליחה, לא הבנתי — אפשר לחזור על זה?", session.voice, actionUrl));
  }

  // Caller is hanging up the conversation politely.
  if (/^(bye|goodbye|thank you,? bye|that'?s all|nothing else)/i.test(speech)) {
    session.history.push({ role: 'user', content: speech });
    saveCall(session);
    incomingSessions.delete(callSid);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${session.voice}">תודה שהתקשרת ל${session.business.name}. להתראות!</Say><Hangup/></Response>`);
  }

  session.history.push({ role: 'user', content: speech });

  const apiKey = process.env.ANTHROPIC_API_KEY || session.user.claudeApiKey;
  if (!apiKey) {
    saveCall(session);
    return res.send(gatherXml("העוזר שלנו לא זמין כרגע, אבל רשמתי את הפנייה שלך. עוד משהו?", session.voice, actionUrl));
  }

  try {
    // Build the system prompt from what THIS owner configured in the dashboard.
    const bizName   = session.user.businessName || 'our restaurant';
    const questions = (session.user.bookingQuestions || []).filter(Boolean).join(', ');
    const today     = new Date().toLocaleDateString('he-IL', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

    const systemPrompt = `אתה מארח טלפוני חכם, חם ומקצועי של "${bizName}".
היום הוא ${today}.
חשוב מאוד: ענה אך ורק בעברית, בכל תשובה, גם אם נראה לך שהלקוח דיבר בשפה אחרת.
${questions ? `כשאתה מקבל הזמנה, שאל: ${questions}.` : 'עזור ללקוח וקבל הזמנות שולחן.'}
אסוף תמיד לפחות: שם האורח, תאריך, שעה ומספר סועדים.
שמור על תשובות קצרות — משפט או שניים, טבעי לדיבור בטלפון (בלי רשימות, בלי markdown).
כשהשם, התאריך, השעה ומספר הסועדים מאושרים — סיים את התשובה עם ה-JSON המדויק הזה בשורה חדשה:
BOOKING:{"name":"...","date":"YYYY-MM-DD","time":"HH:MM","guests":N,"notes":"..."}
אל תוציא את שורת ה-BOOKING עד שכל ארבעת הפרטים אושרו.`;

    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001', // fast — keeps phone latency low
      max_tokens: 250,
      system:     systemPrompt,
      messages:   session.history
    });

    const aiText       = msg.content[0].text;
    const bookingMatch = aiText.match(/BOOKING:(\{[\s\S]*?\})/);
    const replyText    = aiText.replace(/BOOKING:[\s\S]*$/, '').trim();
    session.history.push({ role: 'assistant', content: aiText });
    saveCall(session);

    if (bookingMatch) {
      try {
        const bdata   = JSON.parse(bookingMatch[1]);
        const booking = {
          id: uuidv4(), businessId: session.user.businessId,
          name: bdata.name, phone: session.caller || '',
          date: bdata.date, time: bdata.time,
          guests: parseInt(bdata.guests) || 1,
          notes: bdata.notes || 'Booked via AI phone call',
          status: 'confirmed', source: 'phone',
          transcript: session.history.map(m => ({ role: m.role === 'user' ? 'customer' : 'bot', text: m.content, time: '—' })),
          createdAt: new Date().toISOString()
        };
        const bookings = readBookings(); bookings.push(booking); writeBookings(bookings);
        broadcast(session.user.businessId, { type: 'booking:new', booking });
        console.log(`[voice] booking created for "${bizName}": ${booking.name} ${booking.date} ${booking.time}`);
      } catch (e) { console.error('[voice] booking parse error:', e.message); }

      incomingSessions.delete(callSid);
      return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${session.voice}">${xmlEsc(replyText || 'Your reservation is confirmed. See you soon!')}</Say><Hangup/></Response>`);
    }

    res.send(gatherXml(replyText || "Could you repeat that?", session.voice, actionUrl));
  } catch (e) {
    console.error('[voice] Claude error:', e.message);
    saveCall(session);
    res.send(gatherXml("סליחה, הייתה לי תקלה טכנית קטנה. אפשר לחזור על זה?", session.voice, actionUrl));
  }
});

// Browser "talk to the restaurant" demo (no phone needed) — speech happens
// in the browser; this just runs Claude as the chosen restaurant.
// POST { businessId, messages:[{role,content}] } → { reply, business }
app.post('/api/voice/web-chat', async (req, res) => {
  const list     = readBusinesses();
  const business = list.find(b => b.id === req.body.businessId) || list[0];
  if (!business) return res.status(404).json({ error: 'No business configured' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set on server' });

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 300,
      system:     business.system_prompt,
      messages:   (req.body.messages || []).slice(-20)
    });
    res.json({ reply: (msg.content[0]?.text || '').trim(), business: business.name });
  } catch (e) {
    console.error('[web-chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Incoming call ─────────────────────────────────────────────
app.post('/api/voice/:token', (req, res) => {
  const users = readUsers();
  const user  = users.find(u => u.token === req.params.token);
  res.set('Content-Type', 'text/xml');
  if (!user) return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">Unknown number.</Say><Hangup/></Response>`);

  const callSid  = req.body.CallSid || uuidv4();
  const bizName  = user.businessName || 'the restaurant';

  // Check monthly call budget
  const budget = getCallBudget(user);
  if (budget.remaining <= 0) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>
  <Say voice="Polly.Joanna-Neural">Your monthly call quota of ${budget.limit} minutes has been used. Please upgrade your plan for more minutes. Goodbye!</Say>
  <Hangup/>
</Response>`);
  }
  // Deduct 1 minute when call starts
  deductCallMinute(user);

  // Per-call duration: use business setting (default 60s, max 300s)
  const callDurationSec = Math.min(300, Math.max(10, parseInt(user.callDuration) || 60));

  // Init session
  callSessions.set(callSid, {
    token:   req.params.token,
    user,
    history: [],
    booking: {},
    voice:   'Polly.Joanna-Neural',
    done:    false,
    startAt: Date.now(),
    limitMs: callDurationSec * 1000
  });

  const greeting = `Hello! Welcome to ${bizName}. I'm your AI reservation assistant. You can speak in any language. How can I help you today?`;
  const actionUrl = `/api/voice/${req.params.token}/respond?sid=${callSid}`;

  res.send(gatherXml(greeting, 'Polly.Joanna-Neural', actionUrl));
});

// ── Conversation handler ──────────────────────────────────────
app.post('/api/voice/:token/respond', async (req, res) => {
  res.set('Content-Type', 'text/xml');
  const callSid    = req.query.sid || req.body.CallSid;
  const speech     = (req.body.SpeechResult || '').trim();
  const detectedLang = req.body.LanguageCode || 'en-US';
  const token      = req.params.token;
  const actionUrl  = `/api/voice/${token}/respond?sid=${callSid}`;

  const session = callSessions.get(callSid);
  if (!session) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">Session expired. Please call again.</Say><Hangup/></Response>`);
  }

  // Enforce 60s limit
  if (Date.now() - session.startAt > (session.limitMs - 2000)) {
    callSessions.delete(callSid);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${session.voice}">Your call time has ended. Please call back to continue. Goodbye!</Say><Hangup/></Response>`);
  }

  if (!speech) {
    return res.send(gatherXml("I didn't catch that — could you repeat please?", session.voice, actionUrl));
  }

  // Update voice for detected language
  session.voice = voiceFor(detectedLang);
  session.history.push({ role: 'user', content: speech });

  const apiKey = session.user.claudeApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${session.voice}">AI is not configured. Please contact the restaurant directly.</Say><Hangup/></Response>`);
  }

  try {
    const bizName = session.user.businessName || 'our restaurant';
    const questions = (session.user.bookingQuestions || []).filter(Boolean).join(', ');
    const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

    const systemPrompt = `You are a warm, professional AI booking assistant for "${bizName}".
Today is ${today}.
Speak in the SAME LANGUAGE as the customer (auto-detect from their message).
Collect: guest name, date, time, number of guests${questions ? `, and: ${questions}` : ''}.
Keep replies SHORT (1–2 sentences max). Be friendly and natural.
When you have all booking details, end your reply with this exact JSON on a new line:
BOOKING:{"name":"...","date":"YYYY-MM-DD","time":"HH:MM","guests":N,"notes":"..."}
Do NOT add the BOOKING JSON until you have name, date, time, and guest count confirmed.`;

    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: session.history
    });

    const aiText = msg.content[0].text;

    // Check if booking data included
    const bookingMatch = aiText.match(/BOOKING:(\{[\s\S]*?\})/);
    const replyText   = aiText.replace(/BOOKING:[\s\S]*$/, '').trim();

    session.history.push({ role: 'assistant', content: aiText });

    if (bookingMatch) {
      // Create the booking
      try {
        const bdata = JSON.parse(bookingMatch[1]);
        const newBooking = {
          id: uuidv4(), businessId: session.user.businessId,
          name: bdata.name, phone: req.body.From || '',
          date: bdata.date, time: bdata.time,
          guests: parseInt(bdata.guests) || 1,
          notes: bdata.notes || 'Booked via AI phone call',
          status: 'confirmed', source: 'phone',
          transcript: session.history.map(m => ({ role: m.role === 'user' ? 'customer' : 'bot', text: m.content, time: '—' })),
          createdAt: new Date().toISOString()
        };
        const bookings = readBookings();
        bookings.push(newBooking);
        writeBookings(bookings);
        broadcast(session.user.businessId, { type: 'booking:new', booking: newBooking });
        callSessions.delete(callSid);
      } catch(e) { console.error('[voice] booking parse error:', e.message); }

      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${session.voice}">${xmlEsc(replyText || 'Your reservation is confirmed. See you soon!')}</Say>
  <Hangup/>
</Response>`);
    }

    // Continue conversation
    res.send(gatherXml(replyText || "Could you repeat that?", session.voice, actionUrl));

  } catch(e) {
    console.error('[voice] Claude error:', e.message);
    res.send(gatherXml("Sorry, I had a technical issue. Could you repeat that?", session.voice, actionUrl));
  }
});

// ── Time limit / hangup ───────────────────────────────────────
app.post('/api/voice/:token/hangup', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Your one-minute limit has been reached. Please upgrade your plan for longer calls. Goodbye!</Say>
  <Hangup/>
</Response>`);
});

// ── Twilio no-show call ───────────────────────────────────────────────
async function triggerNoShowCall(booking, bizName, userPlan) {
  const cfg = readConfig();
  if (!cfg.twilioAccountSid || !cfg.twilioAuthToken || !cfg.twilioFromNumber) return;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">Hello ${booking.name}. This is the reservation system at ${bizName}. You have a reservation at ${booking.time} and haven't arrived yet. If you are on your way, we look forward to seeing you. To cancel, please give us a call. Thank you, goodbye.</Say>
</Response>`;

  const raw   = booking.phone.replace(/[^\d+]/g, '');
  const intl  = raw.startsWith('0') ? '+972' + raw.slice(1) : raw;

  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioAccountSid}/Calls.json`,
      {
        method:  'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${cfg.twilioAccountSid}:${cfg.twilioAuthToken}`).toString('base64'),
          'Content-Type':  'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          To: intl, From: cfg.twilioFromNumber, Twiml: twiml,
          ...(CALL_DURATION_SEC[userPlan] ? { TimeLimit: String(CALL_DURATION_SEC[userPlan]) } : {})
        })
      }
    );
    const data = await r.json();
    if (data.sid) console.log(`[no-show] call sent → ${intl} (${data.sid})`);
    else console.warn(`[no-show] Twilio error:`, data.message);
  } catch (e) {
    console.error('[no-show] Twilio fetch error:', e.message);
  }
}

// ── No-show scheduler (every 60s) ────────────────────────────────────
setInterval(() => {
  const now      = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const bookings = readBookings();
  const users    = readUsers();
  let   dirty    = false;

  for (const b of bookings) {
    if (b.status !== 'confirmed') continue;
    if (b.date   !== todayStr)    continue;
    if (b.noShowChecked)          continue;

    const [h, m]      = b.time.split(':').map(Number);
    const bookingTime = new Date(now);
    bookingTime.setHours(h, m, 0, 0);
    const minutesLate = (now - bookingTime) / 60000;

    if (minutesLate >= 15) {
      b.status        = 'noshow';
      b.noShowChecked = true;
      b.noShowAt      = now.toISOString();
      dirty = true;

      broadcast(b.businessId, { type: 'booking:noshow', booking: b });

      const user = users.find(u => u.businessId === b.businessId);
      if (user) triggerNoShowCall(b, user.businessName, user.plan);

      console.log(`[no-show] ${b.name} ${b.time} — no-show`);
    }
  }

  if (dirty) writeBookings(bookings);
}, 60000);

// ── Config (Twilio + Stripe keys) ─────────────────────────────────────
app.get('/api/config', auth, (req, res) => {
  const cfg = readConfig();
  const { stripeSecretKey: _, twilioAuthToken: __, ...safe } = cfg;
  res.json(safe);
});

app.patch('/api/config', auth, (req, res) => {
  const cfg     = readConfig();
  const allowed = ['stripeSecretKey','stripePublishableKey','twilioAccountSid','twilioAuthToken','twilioFromNumber'];
  allowed.forEach(k => { if (req.body[k] !== undefined) cfg[k] = req.body[k]; });
  writeConfig(cfg);
  res.json({ ok: true });
});

// ── Mark arrived ──────────────────────────────────────────────────────
app.patch('/api/bookings/:id/arrived', auth, (req, res) => {
  const list  = readBookings();
  const index = list.findIndex(b => b.id === req.params.id && b.businessId === req.user.businessId);
  if (index === -1) return res.status(404).json({ error: 'Booking not found' });
  list[index].status        = 'arrived';
  list[index].noShowChecked = true;
  list[index].arrivedAt     = new Date().toISOString();
  writeBookings(list);
  broadcast(req.user.businessId, { type: 'booking:updated', booking: list[index] });
  res.json(list[index]);
});

// ── Packages (delivery store) ─────────────────────────────────────────
app.get('/api/packages', auth, (req, res) => {
  res.json(readPackages().filter(p => p.businessId === req.user.businessId));
});

app.post('/api/packages', auth, (req, res) => {
  const { customerName, customerPhone, trackingNumber, carrier, size, shelf, notes } = req.body;
  if (!customerName || !trackingNumber) return res.status(400).json({ error: 'Required fields missing' });
  const pkg = {
    id: 'pkg-' + uuidv4().slice(0, 8),
    businessId: req.user.businessId,
    customerName, customerPhone: customerPhone || '',
    trackingNumber, carrier: carrier || 'other',
    size: size || 'medium', shelf: shelf || '',
    status: 'waiting',
    arrivedAt: new Date().toISOString(),
    pickedUpAt: null, returnedAt: null,
    notes: notes || '',
    createdAt: new Date().toISOString()
  };
  const pkgs = readPackages(); pkgs.push(pkg); writePackages(pkgs);
  broadcast(req.user.businessId, { type: 'package:new', package: pkg });
  res.status(201).json(pkg);
});

app.patch('/api/packages/:id', auth, (req, res) => {
  const pkgs = readPackages();
  const idx = pkgs.findIndex(p => p.id === req.params.id && p.businessId === req.user.businessId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const allowed = ['customerName','customerPhone','trackingNumber','carrier','size','shelf','notes'];
  allowed.forEach(k => { if (req.body[k] !== undefined) pkgs[idx][k] = req.body[k]; });
  writePackages(pkgs);
  broadcast(req.user.businessId, { type: 'package:updated', package: pkgs[idx] });
  res.json(pkgs[idx]);
});

app.patch('/api/packages/:id/pickup', auth, (req, res) => {
  const pkgs = readPackages();
  const idx = pkgs.findIndex(p => p.id === req.params.id && p.businessId === req.user.businessId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  pkgs[idx].status = 'pickedUp'; pkgs[idx].pickedUpAt = new Date().toISOString();
  writePackages(pkgs);
  broadcast(req.user.businessId, { type: 'package:pickedup', package: pkgs[idx] });
  res.json(pkgs[idx]);
});

app.patch('/api/packages/:id/return', auth, (req, res) => {
  const pkgs = readPackages();
  const idx = pkgs.findIndex(p => p.id === req.params.id && p.businessId === req.user.businessId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  pkgs[idx].status = 'returned'; pkgs[idx].returnedAt = new Date().toISOString();
  writePackages(pkgs);
  broadcast(req.user.businessId, { type: 'package:updated', package: pkgs[idx] });
  res.json(pkgs[idx]);
});

app.delete('/api/packages/:id', auth, (req, res) => {
  const pkgs = readPackages();
  const idx = pkgs.findIndex(p => p.id === req.params.id && p.businessId === req.user.businessId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [del] = pkgs.splice(idx, 1); writePackages(pkgs);
  broadcast(req.user.businessId, { type: 'package:deleted', id: del.id });
  res.json({ message: 'Deleted' });
});

// ── Business Brain: Israeli tax calc ─────────────────────────────────
function calcIsraeliTax(monthlyProfit) {
  if (monthlyProfit <= 0) return { incomeTax: 0, bituachLeumi: 0, total: 0 };

  // Bituach Leumi + Bituach Briut for self-employed (2024 rates)
  const LOW_BL = 6331; // 60% of avg monthly wage
  let bituach = 0;
  if (monthlyProfit <= LOW_BL) {
    bituach = monthlyProfit * 0.0975;
  } else {
    bituach = LOW_BL * 0.0975 + (monthlyProfit - LOW_BL) * 0.1783;
  }

  // Mas Hachnasa — monthly brackets 2024
  const brackets = [
    { limit: 6790,    rate: 0.10 },
    { limit: 9730,    rate: 0.14 },
    { limit: 15620,   rate: 0.20 },
    { limit: 21710,   rate: 0.31 },
    { limit: 45180,   rate: 0.35 },
    { limit: Infinity, rate: 0.47 },
  ];
  let incomeTax = 0, prev = 0;
  for (const b of brackets) {
    if (monthlyProfit <= prev) break;
    incomeTax += (Math.min(monthlyProfit, b.limit) - prev) * b.rate;
    prev = b.limit;
    if (monthlyProfit <= b.limit) break;
  }
  incomeTax = Math.max(0, incomeTax - 502); // ~2.25 personal credit points

  return {
    incomeTax:    Math.round(incomeTax),
    bituachLeumi: Math.round(bituach),
    total:        Math.round(incomeTax + bituach),
  };
}

// ── Business Brain endpoint ───────────────────────────────────────────
app.post('/api/brain', auth, async (req, res) => {
  const { revenue, workers, salaryPerWorker, expenses } = req.body;
  const r = parseFloat(revenue)        || 0;
  const w = parseInt(workers)          || 0;
  const s = parseFloat(salaryPerWorker)|| 0;
  const e = parseFloat(expenses)       || 0;

  const totalWorkerCost = w * s;
  const grossProfit     = r - totalWorkerCost - e;
  const tax             = calcIsraeliTax(Math.max(0, grossProfit));
  const netProfit       = grossProfit - tax.total;
  const marginPct       = r > 0 ? ((netProfit / r) * 100).toFixed(1) : 0;

  const calc = { totalWorkerCost, grossProfit, netProfit,
                 incomeTax: tax.incomeTax, bituachLeumi: tax.bituachLeumi, totalTax: tax.total, marginPct };

  const apiKey = req.user.claudeApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.json({ ...calc, recommendation: null, error: 'AI key not configured — add in Business Settings' });
  }

  try {
    const bizLabel = req.user.businessType === 'hotel' ? 'hotel/inn'
                   : req.user.businessType === 'warehouse' ? 'delivery store'
                   : 'restaurant/bar/café';

    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are an experienced US business consultant. Analyze the following financial data for a ${bizLabel} and give a practical recommendation in English.

Monthly data:
- Revenue: $${r.toLocaleString('en-US')}
- Labor: ${w} × $${s.toLocaleString('en-US')} = $${totalWorkerCost.toLocaleString('en-US')}
- Other expenses: $${e.toLocaleString('en-US')}
- Gross profit: $${grossProfit.toLocaleString('en-US')}
- Estimated income tax: $${tax.incomeTax.toLocaleString('en-US')}
- Estimated SS & Medicare: $${tax.bituachLeumi.toLocaleString('en-US')}
- Net profit: $${netProfit.toLocaleString('en-US')} (${marginPct}% margin)

Write a short, practical analysis (4-5 sentences) covering: assessment of the situation, one specific recommendation (hire/raise wages/cut costs/stay the course), and what the profit margin implies. Direct language, no headings.`
      }]
    });

    res.json({ ...calc, recommendation: msg.content[0].text });
  } catch (err) {
    console.error('[brain] AI error:', err.message);
    res.json({ ...calc, recommendation: null, error: 'AI error: ' + err.message });
  }
});

// ── Feedback ─────────────────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { name, email, rating, message, businessName } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  // Save to file
  const feedback = readJSON(FEEDBACK_FILE, []);
  const entry = { id: uuidv4(), name: name||'Anonymous', email: email||'', rating: rating||0, message, businessName: businessName||'', createdAt: new Date().toISOString() };
  feedback.push(entry);
  writeJSON(FEEDBACK_FILE, feedback);

  // Send SMS via Twilio
  const cfg = readConfig();
  const sid  = cfg.twilioAccountSid;
  const auth = cfg.twilioAuthToken;
  const from = cfg.twilioFromNumber;

  if (sid && auth && from) {
    const stars = '⭐'.repeat(Math.min(5, Math.max(0, parseInt(rating)||0)));
    const smsBody = `📬 New ReserveAI Feedback\n${stars} ${rating}/5\nFrom: ${name||'Anonymous'}${email ? ` (${email})` : ''}${businessName ? `\nBusiness: ${businessName}` : ''}\n\n"${message.slice(0,300)}"`;
    try {
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${sid}:${auth}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ To: OWNER_PHONE, From: from, Body: smsBody })
      });
    } catch(e) { console.error('[feedback] SMS error:', e.message); }
  } else {
    console.log('[feedback] Twilio not configured — saved to file only. Message:', message.slice(0,80));
  }

  res.json({ ok: true });
});

// ── Generate promotional ad image via Claude + Playwright ────────────
app.post('/api/generate-ad', auth, async (req, res) => {
  const apiKey = req.user.claudeApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Claude API Key not configured' });

  try {
    const client   = new Anthropic({ apiKey });
    const bizName  = req.user.businessName || 'Our Restaurant';
    const bizAddr  = req.user.businessAddress || '';
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content:
        `Create a punchy promotional ad for "${bizName}" restaurant${bizAddr ? ` at ${bizAddr}` : ''}.
Return ONLY valid JSON (no markdown):
{"headline":"...","tagline":"...","cta":"...","emoji":"...","accentColor":"#hexcolor"}
Rules: headline max 7 words, tagline max 14 words, cta max 5 words, emoji 1 character, accentColor a vibrant hex.` }]
    });

    const match = msg.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Claude did not return valid JSON' });
    const ad = JSON.parse(match[0]);

    // Build HTML ad template
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@700;800;900&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{width:800px;height:420px;background:#0d0f1a;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif;overflow:hidden;}
.card{width:760px;height:380px;border-radius:24px;background:linear-gradient(135deg,#151827 0%,#1a1d2a 100%);border:2px solid ${ad.accentColor}40;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:40px;position:relative;overflow:hidden;}
.card::before{content:'';position:absolute;top:-80px;right:-80px;width:300px;height:300px;background:${ad.accentColor};opacity:.07;border-radius:50%;}
.card::after{content:'';position:absolute;bottom:-60px;left:-60px;width:200px;height:200px;background:${ad.accentColor};opacity:.05;border-radius:50%;}
.emoji{font-size:56px;line-height:1;}
.headline{font-size:2.6rem;font-weight:900;color:#fff;text-align:center;line-height:1.15;}
.accent{color:${ad.accentColor};}
.tagline{font-size:1.05rem;color:#9ca3af;text-align:center;font-weight:500;}
.biz{font-size:.85rem;color:${ad.accentColor};font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;}
.cta-btn{background:${ad.accentColor};color:#000;font-size:.95rem;font-weight:800;padding:12px 32px;border-radius:50px;margin-top:6px;letter-spacing:.3px;}
.badge{position:absolute;top:22px;right:24px;background:${ad.accentColor}20;border:1px solid ${ad.accentColor}50;color:${ad.accentColor};font-size:.68rem;font-weight:700;padding:4px 12px;border-radius:20px;letter-spacing:.5px;}
</style></head><body>
<div class="card">
  <div class="badge">RESERVE AI</div>
  <div class="emoji">${ad.emoji}</div>
  <div class="headline">${ad.headline}</div>
  <div class="tagline">${ad.tagline}</div>
  <div class="biz">${bizName}</div>
  <div class="cta-btn">${ad.cta}</div>
</div>
</body></html>`;

    // Screenshot with Playwright
    const { chromium } = require('playwright');
    const browser  = await chromium.launch();
    const page     = await browser.newPage();
    await page.setViewportSize({ width: 800, height: 420 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const fname    = `ad-${req.user.businessId}-${Date.now()}.png`;
    const fpath    = path.join(__dirname, 'public', 'ads', fname);
    await page.screenshot({ path: fpath });
    await browser.close();

    res.json({ ...ad, imageUrl: `/ads/${fname}` });
  } catch (e) {
    console.error('[generate-ad]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// MULTI-TENANT TWILIO VOICE — route incoming calls by the number dialed
// ──────────────────────────────────────────────────────────────────────
//   businesses table : id, name, twilio_number, system_prompt, created_at
//   calls table      : id, business_id, caller_number, transcript, created_at
//
// Twilio setup: for each pool number, set the Voice webhook
// ("A CALL COMES IN") to:  POST  https://<host>/api/voice/incoming
// Twilio sends `To` (the number that was dialed) → we look up the owner.
// ══════════════════════════════════════════════════════════════════════

const BUSINESSES_FILE = path.join(DATA_DIR, 'businesses.json');
const CALLS_FILE      = path.join(DATA_DIR, 'calls.json');

const readBusinesses  = () => readJSON(BUSINESSES_FILE, []);
const writeBusinesses = d  => writeJSON(BUSINESSES_FILE, d);
const readCalls       = () => readJSON(CALLS_FILE, []);
const writeCalls      = d  => writeJSON(CALLS_FILE, d);

// Your pool of Twilio numbers. Each gets assigned to exactly one business.
const TWILIO_NUMBER_POOL = ['+972722606164']; // your real Twilio number

// Normalize phone numbers so "+972555648787", "972555648787" and
// "0555648787" all compare equal when matching the dialed number.
function normalizeNumber(n) {
  let s = String(n || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return '+' + s.slice(2);
  if (s.startsWith('0'))  return '+972' + s.slice(1); // local IL → E.164
  return '+' + s;
}

// A business's "fake number": a unique 6-digit code customers key in after
// dialing the one shared Twilio line. This is how many businesses share one number.
function genVoiceCode(taken = new Set()) {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (taken.has(code));
  return code;
}

// Backfill a code for every existing business that doesn't have one yet.
(function ensureVoiceCodes() {
  const users = readUsers();
  const taken = new Set(users.map(u => u.voiceCode).filter(Boolean));
  let dirty = false;
  for (const u of users) {
    if (!u.voiceCode) { u.voiceCode = genVoiceCode(taken); taken.add(u.voiceCode); dirty = true; }
  }
  if (dirty) writeUsers(users);
  console.log(`[voice] ${users.length} businesses share line ${TWILIO_NUMBER_POOL[0]} (codes assigned)`);
})();

// ── 2. Business lookup: which restaurant owns the dialed number? ────────
function findBusinessByTwilioNumber(dialedNumber) {
  const target = normalizeNumber(dialedNumber);
  if (!target) return null;
  return readBusinesses().find(b => normalizeNumber(b.twilio_number) === target) || null;
}

// Seed one demo restaurant that owns the in-code pool number, so the
// system identifies a real business out of the box on first run.
(function seedBusinesses() {
  const list = readBusinesses();
  if (list.some(b => normalizeNumber(b.twilio_number) === normalizeNumber(TWILIO_NUMBER_POOL[0]))) return;

  list.push({
    id:            uuidv4(),
    name:          'The Reserve Demo',
    twilio_number: normalizeNumber(TWILIO_NUMBER_POOL[0]),
    system_prompt:
`You are the warm, professional AI phone host for "The Reserve Demo", an upscale neighborhood bistro.

ABOUT THE RESTAURANT
- Cuisine: modern Mediterranean bistro.
- Hours: Sun–Thu 12:00–23:00, Fri–Sat 12:00–24:00. Kitchen closes 30 min before close.
- Address: 123 Main St. Parking available on the street and a lot around back.

MENU HIGHLIGHTS
- Starters: burrata with heirloom tomato, charred octopus, hummus trio.
- Mains: branzino, dry-aged ribeye, wild mushroom risotto (vegan on request).
- Desserts: pistachio basboosa, dark chocolate tart.
- Full bar with natural wines and zero-proof cocktails.

YOUR JOB
- Answer the phone as the restaurant. Greet callers, answer questions about the menu,
  hours, location, and dietary options, and take table reservations.
- For a reservation, collect: guest name, date, time, and party size. Confirm them back.
- Reply in the SAME LANGUAGE the caller uses. Keep replies SHORT — 1–2 sentences,
  natural for speaking aloud (no markdown, no lists read verbatim).
- If you don't know something, offer to take a message rather than inventing details.`,
    created_at:    new Date().toISOString()
  });
  writeBusinesses(list);
  console.log(`[voice] seeded business "${list[list.length-1].name}" → ${list[list.length-1].twilio_number}`);
})();

// In-memory live call sessions, keyed by Twilio CallSid.
const incomingSessions = new Map();

// Persist (insert/update) a call row in the calls table.
function saveCall(session) {
  const calls = readCalls();
  const idx   = calls.findIndex(c => c.id === session.callId);
  const row = {
    id:            session.callId,
    business_id:   session.business.id,
    caller_number: session.caller,
    transcript:    session.history.map(m => ({
      role: m.role === 'user' ? 'caller' : 'assistant',
      text: m.content
    })),
    created_at:    session.createdAt
  };
  if (idx === -1) calls.push(row); else calls[idx] = row;
  writeCalls(calls);
}

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
