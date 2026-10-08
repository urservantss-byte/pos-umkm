// POS UMKM — SPA + offline-first queue (IndexedDB, FIFO, idempotency key)
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const S = {
  token: localStorage.getItem('pos_token') || null,
  user: JSON.parse(localStorage.getItem('pos_user') || 'null'),
  products: [], categories: [], cart: [], activeCat: 0, trx: [],
  settings: { store_name: 'POS UMKM', store_address: '', store_phone: '', receipt_footer: 'Terima kasih 🙏' },
};

async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers['x-pos-token'] = S.token;
  const r = await fetch(url, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b);
const PUT = (u, b) => api('PUT', u, b);
const DEL = (u) => api('DELETE', u);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------- IndexedDB offline queue ----------
const DBQ = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open('posumkm', 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('queue'))
          d.createObjectStore('queue', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('products'))
          d.createObjectStore('products', { keyPath: 'id' });
      };
      rq.onsuccess = () => { DBQ.db = rq.result; resolve(); };
      rq.onerror = () => reject(rq.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = DBQ.db.transaction(store, mode).objectStore(store);
      const rq = fn(t);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  },
  enqueue(item) { return DBQ.tx('queue', 'readwrite', (s) => s.add(item)); },
  dequeue(key) { return DBQ.tx('queue', 'readwrite', (s) => s.delete(key)); },
  allQueued() { return DBQ.tx('queue', 'readonly', (s) => s.getAll()); },
  cacheProducts(list) {
    return new Promise((resolve) => {
      const t = DBQ.db.transaction('products', 'readwrite').objectStore('products');
      t.clear();
      list.forEach((p) => t.put(p));
      t.transaction.oncomplete = resolve;
    });
  },
  cachedProducts() { return DBQ.tx('products', 'readonly', (s) => s.getAll()); },
};

function setOnline(on) {
  $('#sync-badge').classList.toggle('off', !on);
  $('#sync-badge').title = on ? 'Online — tersinkron' : 'Offline — antrean aktif';
  $('#offline-note').classList.toggle('hidden', on);
  if (on) syncQueue();
}
window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));

// FIFO sync + idempotency key
async function syncQueue() {
  if (!navigator.onLine || !S.token) return;
  const items = await DBQ.allQueued().catch(() => []);
  items.sort((a, b) => a.ts - b.ts); // FIFO
  for (const q of items) {
    try {
      await POST('/api/transactions', {
        items: q.items, payment: q.payment, idempotency_key: q.key,
      });
      await DBQ.dequeue(q.key);
    } catch (e) {
      if (/kurang|valid|kosong/.test(e.message)) await DBQ.dequeue(q.key); // data basi, buang
      else break; // network error → coba lagi nanti
    }
  }
  const left = await DBQ.allQueued().catch(() => []);
  if (left.length) toast(left.length + ' transaksi masih antre');
}

// ---------- login ----------
async function doLogin() {
  const u = $('#login-user').value.trim(), p = $('#login-pass').value;
  $('#login-err').textContent = '';
  try {
    const r = await POST('/api/login', { username: u, password: p });
    S.token = r.token; S.user = r.user;
    localStorage.setItem('pos_token', r.token);
    localStorage.setItem('pos_user', JSON.stringify(r.user));
    enterApp();
  } catch (e) { $('#login-err').textContent = e.message; }
}
function doLogout() {
  S.token = null; S.user = null;
  localStorage.removeItem('pos_token'); localStorage.removeItem('pos_user');
  $('#view-app').classList.add('hidden'); $('#view-login').classList.remove('hidden');
}
function enterApp() {
  $('#view-login').classList.add('hidden'); $('#view-app').classList.remove('hidden');
  $('#user-name').textContent = S.user.name + ' (' + S.user.role + ')';
  $('#tab-admin').classList.toggle('hidden', S.user.role !== 'admin');
  loadAll();
}

// ---------- tabs ----------
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $$('.tabpane').forEach((p) => p.classList.add('hidden'));
  $('#tab-' + t.dataset.tab).classList.remove('hidden');
  if (t.dataset.tab === 'laporan') loadLaporan();
  if (t.dataset.tab === 'produk') loadProduk();
  if (t.dataset.tab === 'admin') loadUsers();
}));

async function loadAll() {
  await Promise.all([loadCats(), loadProducts()]);
  if (S.user.role === 'admin') {
    try { S.settings = { ...S.settings, ...(await GET('/api/settings')) }; } catch (e) {}
  }
  renderKasir(); syncQueue();
}

// ---------- kategori ----------
async function loadCats() {
  try { S.categories = await GET('/api/categories'); }
  catch (e) { S.categories = []; }
  renderCatChips();
}
function renderCatChips() {
  const mk = (id, name, color) =>
    `<button class="chip${S.activeCat === id ? ' active' : ''}" data-cat="${id}">` +
    (color ? `<span class="dot" style="background:${color}"></span>` : '') +
    `${name}</button>`;
  $('#cat-chips').innerHTML =
    mk(0, 'Semua') + S.categories.map((c) => mk(c.id, c.name, c.color)).join('');
  $$('#cat-chips .chip').forEach((ch) => ch.addEventListener('click', () => {
    S.activeCat = +ch.dataset.cat; renderCatChips(); renderKasir();
  }));
}

// ---------- produk (kasir grid) ----------
async function loadProducts() {
  try {
    S.products = await GET('/api/products');
    DBQ.cacheProducts(S.products).catch(() => {});
  } catch (e) {
    if (!navigator.onLine) S.products = await DBQ.cachedProducts().catch(() => []);
    else toast('Gagal muat produk: ' + e.message);
  }
}
function renderKasir() {
  const q = $('#kasir-search').value.trim().toLowerCase();
  const list = S.products.filter((p) =>
    (S.activeCat === 0 || p.category_id === S.activeCat) &&
    (!q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q)));
  $('#product-grid').innerHTML = list.map((p) => `
    <div class="pcard${p.stock <= 0 ? ' soldout' : ''}" data-id="${p.id}">
      <div class="pname">${esc(p.name)}</div>
      <div class="pprice">${rupiah(p.price)}</div>
      <div class="pstock">Stok: ${p.stock}</div>
    </div>`).join('') || '<p class="muted">Tidak ada produk.</p>';
  $$('#product-grid .pcard').forEach((el) => el.addEventListener('click', () => {
    addToCart(+el.dataset.id);
  }));
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
$('#kasir-search').addEventListener('input', renderKasir);

// ---------- keranjang ----------
function addToCart(id) {
  const p = S.products.find((x) => x.id === id);
  if (!p || p.stock <= 0) return;
  const line = S.cart.find((x) => x.product_id === id);
  const inCart = line ? line.qty : 0;
  if (inCart + 1 > p.stock) { toast('Stok tidak cukup'); return; }
  if (line) line.qty++;
  else S.cart.push({ product_id: p.id, name: p.name, price: p.price, qty: 1 });
  renderCart();
}
function renderCart() {
  const box = $('#cart-items');
  if (!S.cart.length) {
    box.innerHTML = '<p class="muted">Belum ada item. Klik produk untuk tambah.</p>';
  } else {
    box.innerHTML = S.cart.map((l, i) => `
      <div class="cart-line">
        <div><div class="cl-name">${esc(l.name)}</div>
        <div class="muted small">${rupiah(l.price)} × ${l.qty} = <b>${rupiah(l.price * l.qty)}</b></div></div>
        <div class="cl-qty">
          <button class="qty-btn" data-i="${i}" data-d="-1">−</button><b>${l.qty}</b>
          <button class="qty-btn" data-i="${i}" data-d="1">+</button>
        </div>
      </div>`).join('');
    $$('#cart-items .qty-btn').forEach((b) => b.addEventListener('click', () => {
      const l = S.cart[+b.dataset.i];
      const p = S.products.find((x) => x.id === l.product_id);
      l.qty += +b.dataset.d;
      if (l.qty <= 0) S.cart.splice(+b.dataset.i, 1);
      if (p && l.qty > p.stock) { l.qty = p.stock; toast('Stok maks ' + p.stock); }
      renderCart();
    }));
  }
  const total = S.cart.reduce((a, l) => a + l.price * l.qty, 0);
  $('#cart-total').textContent = rupiah(total);
  $('#btn-checkout').disabled = !S.cart.length;
  calcChange();
}
function cartTotal() { return S.cart.reduce((a, l) => a + l.price * l.qty, 0); }
function calcChange() {
  const pay = parseInt(($('#pay-amount').value || '0').replace(/\D/g, ''), 10) || 0;
  $('#pay-change').textContent = rupiah(Math.max(0, pay - cartTotal()));
}
$('#pay-amount').addEventListener('input', calcChange);
$$('.qp').forEach((b) => b.addEventListener('click', () => {
  const t = cartTotal();
  $('#pay-amount').value = b.dataset.amt === 'uangpas' ? t : +b.dataset.amt;
  calcChange();
}));
$('#btn-clear-cart').addEventListener('click', () => {
  S.cart = []; $('#pay-amount').value = ''; renderCart();
});

$('#btn-checkout').addEventListener('click', async () => {
  const total = cartTotal();
  const pay = parseInt(($('#pay-amount').value || '0').replace(/\D/g, ''), 10) || 0;
  if (pay < total) { toast('Pembayaran kurang'); return; }
  const payload = {
    items: S.cart.map((l) => ({ product_id: l.product_id, qty: l.qty })),
    payment: pay, key: uid(),
  };
  $('#btn-checkout').disabled = true;
  try {
    let trx;
    if (navigator.onLine && S.token) {
      trx = await POST('/api/transactions', {
        items: payload.items, payment: pay, idempotency_key: payload.key,
      });
    } else {
      // offline → antrekan FIFO
      await DBQ.enqueue({ key: payload.key, items: payload.items, payment: pay, ts: Date.now() });
      trx = {
        code: 'OFFLINE-' + payload.key.slice(-6).toUpperCase(),
        total, payment: pay, change: pay - total,
        cashier_name: S.user.name, created_at: Math.floor(Date.now() / 1000),
        items: S.cart.map((l) => ({ product_name: l.name, price: l.price, qty: l.qty, subtotal: l.price * l.qty })),
        offline: true,
      };
      toast('📴 Offline — transaksi diantrekan');
    }
    showReceipt(trx);
    S.cart = []; $('#pay-amount').value = ''; renderCart(); loadProducts().then(renderKasir);
  } catch (e) { toast('Gagal: ' + e.message); }
  finally { $('#btn-checkout').disabled = false; }
});

// ---------- struk ----------
function showReceipt(t) {
  const dt = new Date((t.created_at || Date.now() / 1000) * 1000);
  const st = S.settings;
  const rows = t.items.map((i) =>
    `<tr><td>${esc(i.product_name)}<br><span style="color:#555">${i.qty} × ${rupiah(i.price)}</span></td>` +
    `<td align="right">${rupiah(i.subtotal)}</td></tr>`).join('');
  $('#receipt-body').innerHTML = `
    <h4>🧾 ${esc(st.store_name || 'POS UMKM')}</h4>
    ${st.store_address ? `<div class="rc">${esc(st.store_address)}${st.store_phone ? ' · ' + esc(st.store_phone) : ''}</div>` : ''}
    <div class="rc">Struk Pembelian<br>${esc(t.code || '')}<br>
    ${dt.toLocaleString('id-ID')} · Kasir: ${esc(t.cashier_name || '')}${t.offline ? '<br><b>(OFFLINE — antre sync)</b>' : ''}</div>
    <table>${rows}</table>
    <div class="tot">
      <table>
        <tr><td>Total</td><td align="right">${rupiah(t.total)}</td></tr>
        <tr><td>Bayar</td><td align="right">${rupiah(t.payment)}</td></tr>
        <tr><td>Kembali</td><td align="right">${rupiah(t.change)}</td></tr>
      </table>
    </div>
    <div class="foot">${esc(st.receipt_footer || 'Terima kasih 🙏')}</div>`;
  $('#modal-receipt').classList.remove('hidden');
}
$('#btn-receipt-close').addEventListener('click', () => $('#modal-receipt').classList.add('hidden'));
$('#btn-print').addEventListener('click', () => window.print());

// ---------- produk CRUD ----------
let editingProduct = null;
async function loadProduk() {
  await loadProducts(); await loadCats();
  renderProdukTable(); renderCatList();
  const sel = $('#mp-cat');
  sel.innerHTML = '<option value="">— Tanpa kategori —</option>' +
    S.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}
function renderCatList() {
  $('#cat-list').innerHTML = S.categories.map((c) =>
    `<span class="chip"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}
     <a href="#" data-edit-cat="${c.id}" style="margin-left:8px">✏️</a>
     <a href="#" data-del-cat="${c.id}" style="color:var(--red);margin-left:4px">✕</a></span>`).join('');
  $$('#cat-list [data-del-cat]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('Hapus kategori ini?')) return;
    await DEL('/api/categories/' + a.dataset.delCat);
    loadProduk();
  }));
  $$('#cat-list [data-edit-cat]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const c = S.categories.find((x) => x.id === +a.dataset.editCat);
    const name = prompt('Nama kategori:', c.name);
    if (name === null || !name.trim()) return;
    await PUT('/api/categories/' + c.id, { name: name.trim() });
    loadProduk();
  }));
}
function renderProdukTable() {
  const q = $('#produk-search').value.trim().toLowerCase();
  const list = S.products.filter((p) => !q || p.name.toLowerCase().includes(q));
  $('#produk-tbody').innerHTML = list.map((p) => `
    <tr><td><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.category_name || '—')}</span></td>
    <td class="muted">${esc(p.sku || '—')}</td><td>${rupiah(p.price)}</td><td>${p.stock}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-ghost btn-sm" data-edit="${p.id}">✏️</button>
      <button class="btn btn-ghost btn-sm" data-stock="${p.id}">📦</button>
      <button class="btn btn-ghost btn-sm" data-del="${p.id}">🗑️</button>
    </td></tr>`).join('') || '<tr><td colspan="5" class="muted">Kosong.</td></tr>';
  $$('#produk-tbody [data-edit]').forEach((b) => b.addEventListener('click', () => openProductModal(+b.dataset.edit)));
  $$('#produk-tbody [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Nonaktifkan produk ini?')) return;
    await DEL('/api/products/' + b.dataset.del); loadProduk();
  }));
  $$('#produk-tbody [data-stock]').forEach((b) => b.addEventListener('click', async () => {
    const d = prompt('Tambah/kurang stok (cth: 10 atau -5):', '10');
    if (d === null) return;
    await POST('/api/products/' + b.dataset.stock + '/stock', { delta: parseInt(d, 10) || 0 });
    loadProduk();
  }));
}
$('#produk-search').addEventListener('input', renderProdukTable);
function openProductModal(id) {
  editingProduct = id || null;
  $('#modal-product-title').textContent = id ? 'Edit Produk' : 'Tambah Produk';
  const p = id ? S.products.find((x) => x.id === id) : null;
  $('#mp-name').value = p ? p.name : '';
  $('#mp-cat').value = p && p.category_id ? p.category_id : '';
  $('#mp-price').value = p ? p.price : '';
  $('#mp-stock').value = p ? p.stock : '';
  $('#mp-sku').value = p ? (p.sku || '') : '';
  $('#modal-product').classList.remove('hidden');
}
$('#btn-add-product').addEventListener('click', () => openProductModal(null));
$('#mp-cancel').addEventListener('click', () => $('#modal-product').classList.add('hidden'));
$('#mp-save').addEventListener('click', async () => {
  const body = {
    name: $('#mp-name').value.trim(),
    category_id: $('#mp-cat').value ? +$('#mp-cat').value : null,
    price: parseInt($('#mp-price').value, 10) || 0,
    stock: parseInt($('#mp-stock').value, 10) || 0,
    sku: $('#mp-sku').value.trim() || null,
  };
  if (!body.name) { toast('Nama wajib'); return; }
  if (editingProduct) await PUT('/api/products/' + editingProduct, body);
  else await POST('/api/products', body);
  $('#modal-product').classList.add('hidden');
  loadProduk();
});
$('#btn-add-category').addEventListener('click', async () => {
  const name = prompt('Nama kategori baru:');
  if (!name) return;
  const colors = ['#e84393', '#e17055', '#0984e3', '#6c5ce7', '#00b894', '#fdcb6e'];
  await POST('/api/categories', { name, color: colors[S.categories.length % colors.length] });
  loadProduk();
});

// ---------- laporan ----------
async function loadLaporan() {
  const d = $('#lap-date').value || new Date().toISOString().slice(0, 10);
  try {
    const r = await GET('/api/reports/daily?date=' + d);
    $('#lap-omzet').textContent = rupiah(r.omzet);
    $('#lap-trx').textContent = r.trx;
    $('#lap-avg').textContent = rupiah(r.trx ? Math.round(r.omzet / r.trx) : 0);
    $('#lap-top').innerHTML = r.top.map((t) =>
      `<tr><td>${esc(t.product_name)}</td><td>${t.qty}</td><td>${rupiah(t.subtotal)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="muted">Belum ada penjualan.</td></tr>';
    const max = Math.max(1, ...r.perHour.map((h) => h.omzet));
    $('#lap-hourly').innerHTML = r.perHour.map((h) =>
      `<div class="hbar" style="height:${Math.round((h.omzet / max) * 90)}px" title="${h.h}:00 — ${rupiah(h.omzet)}"><span>${h.h}</span></div>`).join('')
      || '<p class="muted">Belum ada data.</p>';
    const wk = await GET('/api/reports/summary?days=7');
    $('#lap-weekly').innerHTML = wk.map((w) =>
      `<tr><td>${w.date}</td><td>${w.trx}</td><td>${rupiah(w.omzet)}</td></tr>`).join('');
    const trxs = await GET('/api/transactions?limit=20');
    $('#lap-trx-list').innerHTML = trxs.map((t) =>
      `<tr><td>${esc(t.code)}</td><td>${esc(t.cashier_name || '')}</td><td>${rupiah(t.total)}</td>
       <td><button class="btn btn-ghost btn-sm" data-trx="${t.id}">🧾</button></td></tr>`).join('');
    $$('#lap-trx-list [data-trx]').forEach((b) => b.addEventListener('click', async () => {
      const t = await GET('/api/transactions/' + b.dataset.trx);
      showReceipt(t);
    }));
  } catch (e) { toast('Gagal muat laporan: ' + e.message); }
}
$('#btn-lap-refresh').addEventListener('click', loadLaporan);

// ---------- admin ----------
async function loadUsers() {
  try {
    const us = await GET('/api/users');
    $('#adm-users').innerHTML = us.map((u) =>
      `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td>${u.role}</td>
       <td>${u.id !== S.user.id ? `<button class="btn btn-ghost btn-sm" data-del-user="${u.id}">🗑️</button>` : ''}</td></tr>`).join('');
    $$('#adm-users [data-del-user]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Hapus user ini?')) return;
      try { await DEL('/api/users/' + b.dataset.delUser); loadUsers(); toast('User dihapus'); }
      catch (e) { toast(e.message); }
    }));
  } catch (e) { toast(e.message); }
  loadSettings();
}
async function loadSettings() {
  try {
    S.settings = { ...S.settings, ...(await GET('/api/settings')) };
  } catch (e) { /* kasir tidak boleh akses, pakai default */ }
  $('#set-name').value = S.settings.store_name || '';
  $('#set-address').value = S.settings.store_address || '';
  $('#set-phone').value = S.settings.store_phone || '';
  $('#set-footer').value = S.settings.receipt_footer || '';
}
$('#btn-set-save').addEventListener('click', async () => {
  try {
    S.settings = await PUT('/api/settings', {
      store_name: $('#set-name').value.trim(),
      store_address: $('#set-address').value.trim(),
      store_phone: $('#set-phone').value.trim(),
      receipt_footer: $('#set-footer').value.trim(),
    });
    toast('Pengaturan tersimpan');
  } catch (e) { toast(e.message); }
});
$('#btn-adm-add').addEventListener('click', async () => {
  try {
    await POST('/api/users', {
      username: $('#adm-username').value.trim(),
      password: $('#adm-password').value,
      name: $('#adm-name').value.trim(),
    });
    $('#adm-username').value = $('#adm-password').value = $('#adm-name').value = '';
    loadUsers(); toast('Kasir ditambahkan');
  } catch (e) { toast(e.message); }
});

// ---------- boot ----------
$('#btn-login').addEventListener('click', doLogin);
$('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('#btn-logout').addEventListener('click', doLogout);

(async function boot() {
  $('#lap-date').value = new Date().toISOString().slice(0, 10);
  await DBQ.open().catch(() => {});
  try {
    const info = await (await fetch('/api/store-info')).json();
    if (info.store_name) document.querySelector('#view-login h1').textContent = info.store_name;
  } catch (e) {}
  setOnline(navigator.onLine);
  if (S.token) {
    try { const me = await GET('/api/me'); S.user = me.user; enterApp(); }
    catch (e) { doLogout(); }
  }
})();
