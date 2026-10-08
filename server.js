// POS UMKM - Server
// Monolit Express + node:sqlite (bawaan Node 22+, tanpa native build).
// Deploy-friendly (Railway volume /data via DB_PATH).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pos.db');

app.use(express.json({ limit: '2mb' }));

// ---------- DB ----------
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'kasir',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#e84393'
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER,
  price INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  sku TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(category_id) REFERENCES categories(id)
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  cashier_id INTEGER,
  cashier_name TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  payment INTEGER NOT NULL DEFAULT 0,
  change INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS transaction_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  subtotal INTEGER NOT NULL,
  FOREIGN KEY(transaction_id) REFERENCES transactions(id)
);
`);

// Seed: admin default + contoh kategori/produk (hanya kalau kosong)
(function seed() {
  const u = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (u.c === 0) {
    const h = crypto.createHash('sha256').update('admin123').digest('hex');
    db.prepare('INSERT INTO users (username,password,name,role) VALUES (?,?,?,?)')
      .run('admin', h, 'Admin', 'admin');
    db.prepare('INSERT INTO users (username,password,name,role) VALUES (?,?,?,?)')
      .run('kasir', h, 'Kasir 1', 'kasir');
    console.log('[seed] user admin/admin123 & kasir/admin123 dibuat');
  }
  const c = db.prepare('SELECT COUNT(*) AS c FROM categories').get();
  if (c.c === 0) {
    const ins = db.prepare('INSERT INTO categories (name,color) VALUES (?,?)');
    const m = ins.run('Makanan', '#e17055').lastInsertRowid;
    const n = ins.run('Minuman', '#0984e3').lastInsertRowid;
    ins.run('Lainnya', '#6c5ce7');
    const p = db.prepare('INSERT INTO products (name,category_id,price,stock,sku) VALUES (?,?,?,?,?)');
    p.run('Nasi Goreng', m, 15000, 50, 'MK-001');
    p.run('Mie Goreng', m, 13000, 50, 'MK-002');
    p.run('Es Teh Manis', n, 5000, 100, 'MN-001');
    p.run('Kopi Tubruk', n, 8000, 80, 'MN-002');
    console.log('[seed] contoh kategori & produk dibuat');
  }
  const defaults = {
    store_name: 'POS UMKM',
    store_address: 'Jl. Merdeka No. 10',
    store_phone: '0812-0000-0000',
    receipt_footer: 'Terima kasih sudah berbelanja 🙏',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get(k))
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(k, v);
  }
})();

// ---------- helpers ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function auth(req, res, next) {
  const t = req.headers['x-pos-token'];
  if (!t) return res.status(401).json({ error: 'unauthorized' });
  try {
    const [id, sig] = String(t).split('.');
    const user = db.prepare('SELECT id,username,name,role FROM users WHERE id=?').get(id);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (sha(user.username + ':' + user.id + ':posumkm') !== sig)
      return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  } catch (e) { return res.status(401).json({ error: 'unauthorized' }); }
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password wajib' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || user.password !== sha(password))
    return res.status(401).json({ error: 'username/password salah' });
  const token = user.id + '.' + sha(user.username + ':' + user.id + ':posumkm');
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- categories ----------
app.get('/api/categories', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY name').all());
});
app.post('/api/categories', auth, (req, res) => {
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ error: 'nama wajib' });
  const r = db.prepare('INSERT INTO categories (name,color) VALUES (?,?)')
    .run(name, color || '#e84393');
  res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/categories/:id', auth, (req, res) => {
  const { name, color } = req.body || {};
  db.prepare('UPDATE categories SET name=COALESCE(?,name), color=COALESCE(?,color) WHERE id=?')
    .run(name || null, color || null, req.params.id);
  res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id));
});
app.delete('/api/categories/:id', auth, (req, res) => {
  db.prepare('UPDATE products SET category_id=NULL WHERE category_id=?').run(req.params.id);
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- products ----------
app.get('/api/products', auth, (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    rows = db.prepare(`SELECT p.*, c.name AS category_name FROM products p
      LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.active=1 AND (p.name LIKE ? OR p.sku LIKE ?) ORDER BY p.name`)
      .all('%' + q + '%', '%' + q + '%');
  } else {
    rows = db.prepare(`SELECT p.*, c.name AS category_name FROM products p
      LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.active=1 ORDER BY p.name`).all();
  }
  res.json(rows);
});
app.post('/api/products', auth, (req, res) => {
  const { name, category_id, price, stock, sku } = req.body || {};
  if (!name) return res.status(400).json({ error: 'nama wajib' });
  const r = db.prepare('INSERT INTO products (name,category_id,price,stock,sku) VALUES (?,?,?,?,?)')
    .run(name, category_id || null, price | 0, stock | 0, sku || null);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/products/:id', auth, (req, res) => {
  const cur = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'tidak ketemu' });
  const b = req.body || {};
  db.prepare(`UPDATE products SET name=?, category_id=?, price=?, stock=?, sku=?, active=?
    WHERE id=?`).run(
    b.name ?? cur.name, b.category_id !== undefined ? b.category_id : cur.category_id,
    b.price ?? cur.price, b.stock ?? cur.stock, b.sku !== undefined ? b.sku : cur.sku,
    b.active !== undefined ? (b.active ? 1 : 0) : cur.active, req.params.id);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
});
app.delete('/api/products/:id', auth, (req, res) => {
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/products/:id/stock', auth, (req, res) => {
  const { delta } = req.body || {};
  db.prepare('UPDATE products SET stock = stock + ? WHERE id=?').run(delta | 0, req.params.id);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
});

// ---------- transactions ----------
function nextCode() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const n = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE code LIKE ?")
    .get('TRX-' + ymd + '-%').c + 1;
  return 'TRX-' + ymd + '-' + String(n).padStart(4, '0');
}
app.post('/api/transactions', auth, (req, res) => {
  const { items, payment, idempotency_key } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'items kosong' });

  // idempotency: kalau key sudah ada, kembalikan transaksi lama
  if (idempotency_key) {
    const ex = db.prepare('SELECT * FROM transactions WHERE idempotency_key=?').get(idempotency_key);
    if (ex) {
      ex.items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id=?').all(ex.id);
      return res.json({ ...ex, duplicate: true });
    }
  }

  try {
    db.exec('BEGIN');
    let total = 0;
    const lines = [];
    for (const it of items) {
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(it.product_id);
      if (!p) throw new Error('produk tidak valid: ' + it.product_id);
      const qty = Math.max(1, it.qty | 0);
      if (p.stock < qty) throw new Error('stok kurang: ' + p.name);
      const sub = p.price * qty;
      total += sub;
      lines.push({ p, qty, sub });
    }
    const pay = payment | 0;
    if (pay < total) throw new Error('pembayaran kurang');
    const code = nextCode();
    const r = db.prepare(`INSERT INTO transactions
      (code,cashier_id,cashier_name,total,payment,change,idempotency_key)
      VALUES (?,?,?,?,?,?,?)`).run(code, req.user.id, req.user.name, total, pay, pay - total,
      idempotency_key || null);
    const tid = Number(r.lastInsertRowid);
    const insItem = db.prepare(`INSERT INTO transaction_items
      (transaction_id,product_id,product_name,price,qty,subtotal) VALUES (?,?,?,?,?,?)`);
    const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id=?');
    for (const l of lines) {
      insItem.run(tid, l.p.id, l.p.name, l.p.price, l.qty, l.sub);
      decStock.run(l.qty, l.p.id);
    }
    db.exec('COMMIT');
    const trx = db.prepare('SELECT * FROM transactions WHERE id=?').get(tid);
    trx.items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id=?').all(tid);
    res.json(trx);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/transactions', auth, (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit || '30', 10));
  res.json(db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT ?').all(limit));
});
app.get('/api/transactions/:id', auth, (req, res) => {
  const trx = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!trx) return res.status(404).json({ error: 'tidak ketemu' });
  trx.items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id=?').all(trx.id);
  res.json(trx);
});

// ---------- reports ----------
app.get('/api/reports/daily', auth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const start = Math.floor(new Date(date + 'T00:00:00').getTime() / 1000);
  const end = Math.floor(new Date(date + 'T23:59:59').getTime() / 1000);
  const sum = db.prepare(`SELECT COUNT(*) AS trx, COALESCE(SUM(total),0) AS omzet
    FROM transactions WHERE created_at BETWEEN ? AND ?`).get(start, end);
  const top = db.prepare(`SELECT product_name, SUM(qty) AS qty, SUM(subtotal) AS subtotal
    FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id
    WHERE t.created_at BETWEEN ? AND ? GROUP BY product_name ORDER BY qty DESC LIMIT 10`)
    .all(start, end);
  const perHour = db.prepare(`SELECT strftime('%H', datetime(created_at,'unixepoch')) AS h,
    COUNT(*) AS trx, SUM(total) AS omzet FROM transactions
    WHERE created_at BETWEEN ? AND ? GROUP BY h ORDER BY h`).all(start, end);
  res.json({ date, ...sum, top, perHour });
});
app.get('/api/reports/summary', auth, (req, res) => {
  const days = Math.min(30, parseInt(req.query.days || '7', 10));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const start = Math.floor(new Date(d + 'T00:00:00').getTime() / 1000);
    const end = Math.floor(new Date(d + 'T23:59:59').getTime() / 1000);
    const s = db.prepare(`SELECT COUNT(*) AS trx, COALESCE(SUM(total),0) AS omzet
      FROM transactions WHERE created_at BETWEEN ? AND ?`).get(start, end);
    out.push({ date: d, ...s });
  }
  res.json(out);
});

// ---------- settings ----------
const SETTING_KEYS = ['store_name', 'store_address', 'store_phone', 'receipt_footer'];
function allSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
  return out;
}
app.get('/api/store-info', (req, res) => {
  res.json({ store_name: (allSettings().store_name || 'POS UMKM') });
});
app.get('/api/settings', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json(allSettings());
});
app.put('/api/settings', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const b = req.body || {};
  for (const k of SETTING_KEYS) {
    if (b[k] !== undefined)
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(k, String(b[k]));
  }
  res.json(allSettings());
});

// ---------- users (admin) ----------
app.get('/api/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json(db.prepare('SELECT id,username,name,role,created_at FROM users ORDER BY id').all());
});
app.post('/api/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const { username, password, name, role } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: 'lengkapi data' });
  try {
    const r = db.prepare('INSERT INTO users (username,password,name,role) VALUES (?,?,?,?)')
      .run(username, sha(password), name, role === 'admin' ? 'admin' : 'kasir');
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: 'username sudah dipakai' }); }
});
app.delete('/api/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  if (+req.params.id === req.user.id) return res.status(400).json({ error: 'tidak bisa hapus akun sendiri' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- static ----------
const PUB = path.join(__dirname, 'public');
app.use(express.static(PUB, { maxAge: '1d', setHeaders: (res, p) => {
  if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
}}));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(PUB, 'index.html'));
});

app.listen(PORT, () => console.log(`[pos-umkm] jalan di :${PORT} (db: ${DB_PATH})`));
