/**
 * Penulis Keuangan Pribadi versi Google Apps Script (tanpa server HP).
 *
 * Keamanan:
 * - PIN_HASH dan PIN_SALT disimpan di Script Properties, bukan di source.
 * - Setup PIN pertama memakai SETUP_TOKEN sementara di Script Properties;
 *   token dihapus otomatis setelah PIN berhasil dibuat.
 * - Login hanya lewat POST /exec {action:"login", pin:"..."}.
 * - Semua baca/tulis data memakai token sesi. PIN tidak pernah dikirim di URL.
 * - Ubah PIN lewat POST /exec {action:"change-pin", ...}; semua sesi lama dicabut.
 * - File bukti disimpan privat di Drive; tidak lagi dibagikan ANYONE_WITH_LINK.
 *
 * Konfigurasi Script Properties:
 *   SETUP_TOKEN  = kode setup sementara (minimal 20 karakter; dihapus saat setup)
 *   PIN_HASH     = SHA-256(PIN + "|" + PIN_SALT), 64 karakter hex (dibuat saat setup)
 *   PIN_SALT     = salt acak (dibuat saat setup)
 *   AUTH_VERSION = versi sesi acak (dibuat saat setup; berubah saat ganti PIN)
 * Opsional:
 *   SHEET_ID     = ID spreadsheet (default di bawah)
 *   DRIVE_FOLDER = nama folder bukti (default "Bukti Keuangan Pribadi")
 *
 * Timezone spreadsheet/script sebaiknya Asia/Jakarta.
 */

var DEFAULT_SHEET_ID = '1JJKxdmyq-dbochsEUEo8-zqE7rzXihU6fj-7sLgCNKE';
var TAB = 'Transaksi';
var TAB_ANG = 'Anggaran';
var TAB_OPNAME = 'Opname';
var TAB_TABUNGAN = 'Target Tabungan';
var TAB_AKUN = 'Akun';
var TAB_KATEGORI = 'Kategori Master';
var TAB_RENCANA = 'Rencana';
var MASTER_DATA_KEY = 'MASTER_DATA_V1';
var BUILD = 'p1-20261104';
var TZ = 'Asia/Jakarta';
var FOLDER_DEFAULT = 'Bukti Keuangan Pribadi';
var HDR_H = 'Akun Tujuan / Pihak';
var HDR_ID = 'ID';
var HDR_REQ = 'Request ID';
var VALID_TIPE = ['Pemasukan', 'Pengeluaran', 'Transfer', 'Piutang', 'Hutang', 'Opname/Koreksi'];
var SESSION_TTL_SECONDS = 21600; // 6 jam; batas maksimum CacheService
var LOGIN_WINDOW_SECONDS = 900;
var MAX_LOGIN_FAILS = 5;
var MAX_SETUP_FAILS = 5;
var MIN_SETUP_TOKEN_LENGTH = 20;

/* ======================= ROUTER ======================= */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || 'ping').replace(/^\//, '');
  try {
    if (action === 'ping' || action === '') {
      return out({
        ok: true,
        service: 'keuangan-pribadi',
        mode: 'apps-script',
        build: BUILD,
        configured: !!pinConfig_(),
        setup: !pinConfig_() && !!setupToken_(),
        time: nowStr()
      });
    }
    return out({
      ok: false,
      code: 405,
      error: 'Akses data hanya melalui POST terautentikasi.'
    });
  } catch (err) {
    return out({ ok: false, code: 500, error: msg(err) });
  }
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    var b;
    try {
      b = JSON.parse(raw);
    } catch (parseErr) {
      return out({ ok: false, code: 400, error: 'Body JSON tidak valid.' });
    }
    if (!b || typeof b !== 'object') {
      return out({ ok: false, code: 400, error: 'Body JSON tidak valid.' });
    }

    var action = String(b.action || '').replace(/^\//, '');
    if (action === 'setup') return setupPin_(b);
    if (action === 'login') return login_(b);
    if (action === 'logout') {
      if (sessionOk_(b.token)) CacheService.getScriptCache().remove(sessionKey_(b.token));
      return out({ ok: true });
    }

    if (!sessionOk_(b.token)) {
      return out({ ok: false, code: 401, error: 'Sesi tidak valid atau sudah berakhir. Silakan login ulang.' });
    }

    if (action === 'change-pin') return changePin_(b);

    if (action === 'data') {
      var data = readAll_();
      data.ok = true;
      data.time = nowStr();
      return out(data);
    }
    if (action === 'list') {
      return out({ ok: true, items: listRows(b.n) });
    }
    if (action === 'anggaran') {
      return out({ ok: true, items: readAnggaran() });
    }

    // Seluruh aksi tulis tetap memerlukan PIN, di samping token sesi.
    if (!pinOk(b.pin)) return out({ ok: false, code: 403, error: 'PIN salah' });

    if (action === 'verify-pin') return out({ ok: true, verified: true });
    if (action === 'add') return actAdd(b);
    if (action === 'update') return actUpdate(b);
    if (action === 'delete') return actDelete(b);
    if (action === 'anggaran/save') return actAngSave(b);
    if (action === 'anggaran/delete') return actAngDelete(b);
    if (action === 'akun/save') return actAkunSave(b);
    if (action === 'akun/delete') return actAkunArchive(b);
    if (action === 'kategori/save') return actKategoriSave(b);
    if (action === 'kategori/delete') return actKategoriArchive(b);
    if (action === 'kategori/merge') return actKategoriMerge(b);
    if (action === 'target/save') return actTargetSave(b);
    if (action === 'target/delete') return actTargetDelete(b);
    if (action === 'rencana/save') return actRencanaSave(b);
    if (action === 'rencana/delete') return actRencanaDelete(b);

    return out({ ok: false, code: 404, error: 'action tidak dikenal: ' + action });
  } catch (err) {
    return out({ ok: false, code: 500, error: msg(err) });
  }
}

/* ======================= SESI & LOGIN ======================= */

function login_(b) {
  var cfg = pinConfig_();
  if (!cfg) {
    return out({
      ok: false,
      code: 503,
      error: 'PIN belum dikonfigurasi di Script Properties. Ikuti panduan keamanan.'
    });
  }

  if (loginLocked_()) {
    return out({
      ok: false,
      code: 429,
      error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.'
    });
  }

  var pin = String(b.pin || '');
  if (!/^\d{6}$/.test(pin) || !pinOk(pin)) {
    recordLoginFail_();
    return out({ ok: false, code: 403, error: 'PIN salah' });
  }

  clearLoginFail_();
  var session = issueSession_();
  return out({
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    expiresIn: session.expiresIn
  });
}

function issueSession_() {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  CacheService.getScriptCache().put(
    sessionKey_(token),
    String(expiresAt) + '|' + authVersion_(),
    SESSION_TTL_SECONDS
  );
  return { token: token, expiresAt: expiresAt, expiresIn: SESSION_TTL_SECONDS };
}

function setupPin_(b) {
  if (pinConfig_()) {
    return out({ ok: false, code: 409, error: 'PIN sudah dikonfigurasi. Silakan login.' });
  }
  var setupToken = setupToken_();
  if (!setupToken) {
    return out({ ok: false, code: 503, error: 'Setup PIN belum diaktifkan. Tambahkan SETUP_TOKEN di Script Properties atau jalankan BUAT_KODE_SETUP().' });
  }
  if (setupLocked_()) {
    return out({ ok: false, code: 429, error: 'Terlalu banyak percobaan setup. Coba lagi dalam 15 menit.' });
  }

  var code = String(b.setupCode || '').trim();
  if (!code || code !== setupToken) {
    recordSetupFail_();
    return out({ ok: false, code: 403, error: 'Kode setup salah' });
  }

  var pin = String(b.pin || '');
  var confirm = String(b.pinConfirm || '');
  if (!/^\d{6}$/.test(pin)) {
    return out({ ok: false, code: 400, error: 'PIN baru harus 6 angka.' });
  }
  if (pin !== confirm) {
    return out({ ok: false, code: 400, error: 'Konfirmasi PIN tidak sama.' });
  }

  var salt = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var session = withLock_(function () {
    if (pinConfig_() || setupToken_() !== setupToken) return null;
    PropertiesService.getScriptProperties().setProperties({
      PIN_SALT: salt,
      PIN_HASH: h(pin + '|' + salt),
      AUTH_VERSION: newAuthVersion_()
    });
    PropertiesService.getScriptProperties().deleteProperty('SETUP_TOKEN');
    return issueSession_();
  });
  if (!session) {
    return out({ ok: false, code: 409, error: 'PIN sudah dikonfigurasi. Silakan login.' });
  }
  clearSetupFail_();
  return out({
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    expiresIn: session.expiresIn
  });
}

function changePin_(b) {
  if (loginLocked_()) {
    return out({ ok: false, code: 429, error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.' });
  }
  var current = String(b.pin || '');
  if (!pinOk(current)) {
    recordLoginFail_();
    return out({ ok: false, code: 403, error: 'PIN sekarang salah' });
  }
  var next = String(b.newPin || '');
  var confirm = String(b.pinConfirm || '');
  if (!/^\d{6}$/.test(next)) {
    return out({ ok: false, code: 400, error: 'PIN baru harus 6 angka.' });
  }
  if (next !== confirm) {
    return out({ ok: false, code: 400, error: 'Konfirmasi PIN baru tidak sama.' });
  }
  if (next === current) {
    return out({ ok: false, code: 400, error: 'PIN baru harus berbeda dari PIN sekarang.' });
  }

  var salt = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var version = newAuthVersion_();
  withLock_(function () {
    PropertiesService.getScriptProperties().setProperties({
      PIN_SALT: salt,
      PIN_HASH: h(next + '|' + salt),
      AUTH_VERSION: version
    });
  });
  clearLoginFail_();
  CacheService.getScriptCache().remove(sessionKey_(b.token));
  return out({ ok: true, relogin: true });
}

function sessionKey_(token) {
  return 'sess:' + String(token || '');
}

function sessionOk_(token) {
  token = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(sessionKey_(token));
  if (!raw) return false;
  var parts = String(raw).split('|');
  var exp = Number(parts[0]);
  if (!exp || Date.now() >= exp || String(parts[1] || '') !== authVersion_()) {
    cache.remove(sessionKey_(token));
    return false;
  }
  return true;
}

function loginLocked_() {
  return !!CacheService.getScriptCache().get('login_lock_v1');
}

function recordLoginFail_() {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('login_fail_v1') || 0) + 1;
  cache.put('login_fail_v1', String(n), LOGIN_WINDOW_SECONDS);
  if (n >= MAX_LOGIN_FAILS) {
    cache.put('login_lock_v1', '1', LOGIN_WINDOW_SECONDS);
    cache.remove('login_fail_v1');
  }
}

function clearLoginFail_() {
  var cache = CacheService.getScriptCache();
  cache.remove('login_fail_v1');
  cache.remove('login_lock_v1');
}

function setupLocked_() {
  return !!CacheService.getScriptCache().get('setup_lock_v1');
}

function recordSetupFail_() {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('setup_fail_v1') || 0) + 1;
  cache.put('setup_fail_v1', String(n), LOGIN_WINDOW_SECONDS);
  if (n >= MAX_SETUP_FAILS) {
    cache.put('setup_lock_v1', '1', LOGIN_WINDOW_SECONDS);
    cache.remove('setup_fail_v1');
  }
}

function clearSetupFail_() {
  var cache = CacheService.getScriptCache();
  cache.remove('setup_fail_v1');
  cache.remove('setup_lock_v1');
}

/* ======================= BACA DATA ======================= */

function readAll_() {
  ensureMasterData_();
  return {
    trx: readSheetMatrix_(TAB, 9),
    opname: readSheetMatrix_(TAB_OPNAME, 6),
    anggaran: readSheetMatrix_(TAB_ANG, 3),
    tabungan: readSheetMatrix_(TAB_TABUNGAN, 7),
    akun: readSheetMatrix_(TAB_AKUN, 6),
    kategori: readSheetMatrix_(TAB_KATEGORI, 5),
    rencana: readSheetMatrix_(TAB_RENCANA, 7)
  };
}

/**
 * Mengembalikan matriks baris demi baris, kompatibel dengan parser lama.
 * Tanggal dinormalisasi ke YYYY-MM-DD agar tidak bergantung timezone browser.
 */
function readSheetMatrix_(name, width) {
  var sh = sheetTab(name);
  var last = sh.getLastRow();
  if (last < 1) return [];
  var vals = sh.getRange(1, 1, last, width).getValues();
  return vals.map(function (row) {
    return row.map(function (v) {
      var tag = Object.prototype.toString.call(v);
      if (tag === '[object Date]') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
      if (v === null || v === undefined) return '';
      return v;
    });
  });
}

/* ======================= MASTER DATA ======================= */

function ensureMasterTabs_(ss) {
  var specs = [
    { name: TAB_AKUN, headers: ['Nama', 'Tipe', 'Aktif', 'Urutan', 'Default', 'Catatan'] },
    { name: TAB_KATEGORI, headers: ['Nama', 'Tipe', 'Kelompok', 'Aktif', 'Urutan'] },
    { name: TAB_RENCANA, headers: ['Jenis', 'Label', 'Nominal', 'Catatan', 'Warna', 'Urutan', 'Aktif'] },
    { name: TAB_TABUNGAN, headers: ['Nama Target', 'Target (Rp)', 'Terkumpul (Rp)', 'Sisa (Rp)', 'Progress', 'Deadline', 'Status'] }
  ];
  for (var i = 0; i < specs.length; i++) {
    var sh = ss.getSheetByName(specs[i].name);
    if (!sh) sh = ss.insertSheet(specs[i].name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, specs[i].headers.length).setValues([specs[i].headers]);
    }
  }
}

function ensureMasterData_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(MASTER_DATA_KEY) === '1') {
    ensureMasterTabs_(SpreadsheetApp.openById(sheetId_()));
    return;
  }
  withLock_(function () {
    if (props.getProperty(MASTER_DATA_KEY) === '1') {
      ensureMasterTabs_(SpreadsheetApp.openById(sheetId_()));
      return;
    }
    var ss = SpreadsheetApp.openById(sheetId_());
    ensureMasterTabs_(ss);
    seedMasterData_(ss);
    props.setProperty(MASTER_DATA_KEY, '1');
  });
}

/**
 * Pintu masuk publik untuk menjalankan migrasi dari dropdown Run di editor.
 * Apps Script menyembunyikan fungsi berakhiran "_" dari dropdown, jadi
 * jangan panggil ensureMasterData_ langsung dari editor.
 */
function siapkanDataMaster() {
  ensureMasterData_();
}

function seedMasterData_(ss) {
  var akunSh = ss.getSheetByName(TAB_AKUN);
  var trSh = ss.getSheetByName(TAB);
  if (akunSh.getLastRow() < 2) {
    var names = [], seen = {};
    function addName(n) {
      n = cleanText_(n, 40);
      if (!n) return;
      var key = n.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      names.push(n);
    }
    var legacyKatSh = ss.getSheetByName('Kategori');
    if (legacyKatSh && legacyKatSh.getLastRow() > 1) {
      var legacyAkunVals = legacyKatSh.getRange(2, 3, legacyKatSh.getLastRow() - 1, 1).getValues();
      for (var lai = 0; lai < legacyAkunVals.length; lai++) addName(legacyAkunVals[lai][0]);
    }
    var opSh = ss.getSheetByName(TAB_OPNAME);
    if (opSh && opSh.getLastRow() > 1) {
      var opVals = opSh.getRange(2, 2, opSh.getLastRow() - 1, 1).getValues();
      for (var oi = 0; oi < opVals.length; oi++) addName(opVals[oi][0]);
    }
    if (trSh && trSh.getLastRow() > 1) {
      var trVals = trSh.getRange(2, 1, trSh.getLastRow() - 1, 8).getValues();
      for (var ti = 0; ti < trVals.length; ti++) {
        addName(trVals[ti][5]);
        addName(trVals[ti][7]);
      }
    }
    if (names.length) {
      var akunRows = names.map(function (n, idx) {
        return [n, inferAkunTipe_(n), true, idx + 1, n === 'Tunai' || (idx === 0 && names.indexOf('Tunai') < 0), ''];
      });
      akunSh.getRange(2, 1, akunRows.length, 6).setValues(akunRows);
    }
  }

  var katSh = ss.getSheetByName(TAB_KATEGORI);
  if (katSh.getLastRow() < 2) {
    var catMap = {}, catOrder = [];
    function addCat(n, tipe) {
      n = cleanText_(n, 60);
      if (!n) return;
      var key = n.toLowerCase();
      if (!catMap[key]) { catMap[key] = { nama: n, types: {} }; catOrder.push(key); }
      if (tipe) catMap[key].types[tipe] = true;
    }
    var angSh = ss.getSheetByName(TAB_ANG);
    if (angSh && angSh.getLastRow() > 1) {
      var angVals = angSh.getRange(2, 1, angSh.getLastRow() - 1, 1).getValues();
      for (var ai = 0; ai < angVals.length; ai++) addCat(angVals[ai][0], 'Pengeluaran');
    }
    if (trSh && trSh.getLastRow() > 1) {
      var trCatVals = trSh.getRange(2, 3, trSh.getLastRow() - 1, 2).getValues();
      for (var ci = 0; ci < trCatVals.length; ci++) addCat(trCatVals[ci][0], trCatVals[ci][1]);
    }
    var legacyKatSh = ss.getSheetByName('Kategori');
    if (legacyKatSh && legacyKatSh.getLastRow() > 1) {
      var legacyKatVals = legacyKatSh.getRange(2, 1, legacyKatSh.getLastRow() - 1, 2).getValues();
      for (var lki = 0; lki < legacyKatVals.length; lki++) {
        addCat(legacyKatVals[lki][0], 'Pemasukan');
        addCat(legacyKatVals[lki][1], 'Pengeluaran');
      }
    }
    if (catOrder.length) {
      var katRows = catOrder.map(function (key, idx) {
        var item = catMap[key];
        var types = Object.keys(item.types);
        var tipe = types.length === 1 ? types[0] : (types.length > 1 ? 'Umum' : 'Pengeluaran');
        return [item.nama, tipe, '', true, idx + 1];
      });
      katSh.getRange(2, 1, katRows.length, 5).setValues(katRows);
    }
  }

  var renSh = ss.getSheetByName(TAB_RENCANA);
  if (renSh.getLastRow() < 2) {
    renSh.getRange(2, 1, 4, 7).setValues([
      ['Baseline', 'Pemasukan bulanan', 3100000, 'Baseline rencana awal', '#0e7a4f', 1, true],
      ['Saving', 'Persiapan Menikah', 1000000, 'Dana fleksibel untuk horizon 1–2 tahun', '#4dabf7', 2, true],
      ['Saving', 'Tabungan Gadai Sawah', 500000, 'Target Rp30 juta, setor Rp500rb/bulan', '#ff8787', 3, true],
      ['Saving', 'Dana Lebaran', 125000, 'Target tahunan Rp1,5 juta', '#ffd43b', 4, true]
    ]);
  }
}

function inferAkunTipe_(name) {
  var n = String(name || '').toLowerCase();
  if (/piutang/.test(n)) return 'Piutang';
  if (/spaylater|kartu kredit|jenius/.test(n)) return 'Kewajiban';
  return 'Aset';
}

function boolVal_(v, fallback) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    var s = v.toLowerCase().trim();
    if (s === 'false' || s === '0' || s === 'tidak' || s === 'no') return false;
    if (s === 'true' || s === '1' || s === 'ya' || s === 'yes') return true;
  }
  return fallback;
}

function replaceExact_(tabName, col, from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  if (!from || !to || from === to) return 0;
  var sh = sheetTab(tabName);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var rng = sh.getRange(2, col, last - 1, 1);
  var vals = rng.getValues();
  var changed = 0;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim() === from) {
      vals[i][0] = to;
      changed++;
    }
  }
  if (changed) rng.setValues(vals);
  return changed;
}

function appendOpname_(name, actual) {
  var sh = sheetTab(TAB_OPNAME);
  var row = lastDataRow(sh) + 1;
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var amount = Math.round(toNum(actual));
  sh.getRange(row, 1, 1, 6).setValues([[tglObj(today), name, amount, amount, 0, 'Saldo awal akun baru']]);
  sh.getRange(row, 1).setNumberFormat('dd MMM yyyy');
  sh.getRange(row, 3, 1, 3).setNumberFormat('#,##0');
}

function listRows(n) {
  var sh = sheetTab(TAB);
  var last = sh.getLastRow();
  if (last < 2) return [];

  var vals = sh.getRange(2, 1, last - 1, 10).getValues();
  var outItems = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (!r[0] || String(r[0]).trim() === '') continue;
    var tipe = String(r[3] || '').trim();
    if (VALID_TIPE.indexOf(tipe) < 0) continue;
    outItems.push({
      row: i + 2,
      id: String(r[8] || '').trim(),
      tanggal: isoOf(r[0]),
      tanggalTampil: isoOf(r[0]),
      keterangan: cleanText_(r[1], 160),
      kategori: cleanText_(r[2], 60),
      tipe: tipe,
      nominal: toNum(r[4]),
      akun: cleanText_(r[5], 40),
      bukti: String(r[6] || '').trim(),
      akunTujuan: cleanText_(r[7], 60)
    });
  }
  outItems.sort(function (a, b) { return b.row - a.row; });

  var lim = intVal(n);
  if (!lim || lim < 1) lim = 300;
  if (lim > 5000) lim = 5000;
  return outItems.slice(0, lim);
}

function readAnggaran() {
  var sh = sheetTab(TAB_ANG);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 3).getValues();
  var items = [];
  for (var i = 0; i < vals.length; i++) {
    var kat = cleanText_(vals[i][0], 60);
    if (!kat) continue;
    items.push({ row: i + 2, kat: kat, t1: toNum(vals[i][1]), t2: toNum(vals[i][2]) });
  }
  return items;
}

/* ======================= AKSI TULIS ======================= */

function actAdd(b) {
  var f = fields(b);
  if (f.error) return out({ ok: false, code: 400, error: f.error });

  var req = cleanRequestId_(b.requestId);
  var sh = sheetTab(TAB);

  var early = withLock_(function () {
    ensureHeader(sh);
    if (req) {
      var hit = findByRequestId_(sh, req);
      if (hit) return hit;
    }
    return null;
  });
  if (early) {
    return out({
      ok: true,
      duplicate: true,
      row: early.row,
      id: early.id,
      mode: 'apps-script',
      tanggal: f.tgl,
      keterangan: f.ket,
      kategori: f.kat,
      tipe: f.tipe,
      nominal: f.nom,
      akun: f.akun,
      akunTujuan: f.tujuan
    });
  }

  var bukti = '';
  if (b.buktiBase64) {
    try {
      bukti = upload(b.buktiBase64, b.buktiName, f.tgl, f.ket);
    } catch (uploadErr) {
      return out({ ok: false, code: 400, error: 'Upload bukti gagal: ' + msg(uploadErr) });
    }
  }

  var saved = withLock_(function () {
    ensureHeader(sh);
    if (req) {
      var hit = findByRequestId_(sh, req);
      if (hit) return { row: hit.row, id: hit.id, duplicate: true };
    }
    var row = lastDataRow(sh) + 1;
    var id = Utilities.getUuid();
    sh.getRange(row, 1, 1, 10).setValues([[
      tglObj(f.tgl), f.ket, f.kat, f.tipe, f.nom, f.akun, bukti, f.tujuan, id, req || ''
    ]]);
    formatRow(sh, row);
    return { row: row, id: id, duplicate: false };
  });

  return out({
    ok: true,
    duplicate: !!saved.duplicate,
    row: saved.row,
    id: saved.id,
    mode: 'apps-script',
    tanggal: f.tgl,
    keterangan: f.ket,
    kategori: f.kat,
    tipe: f.tipe,
    nominal: f.nom,
    akun: f.akun,
    akunTujuan: f.tujuan,
    bukti: bukti
  });
}

function actUpdate(b) {
  var f = fields(b);
  if (f.error) return out({ ok: false, code: 400, error: f.error });

  var sh = sheetTab(TAB);
  var result = withLock_(function () {
    ensureHeader(sh);
    var row = resolveRow_(sh, b);
    var old = sh.getRange(row, 1, 1, 10).getValues()[0] || [];
    var bukti = String(old[6] || '').trim();
    if (b.hapusBukti) bukti = '';
    if (b.buktiBase64) {
      bukti = upload(b.buktiBase64, b.buktiName, f.tgl, f.ket);
    }
    var id = cleanId_(old[8]) || Utilities.getUuid();
    var req = cleanRequestId_(old[9]);
    sh.getRange(row, 1, 1, 10).setValues([[
      tglObj(f.tgl), f.ket, f.kat, f.tipe, f.nom, f.akun, bukti, f.tujuan, id, req
    ]]);
    formatRow(sh, row);
    return { row: row, id: id, bukti: bukti };
  });

  return out({
    ok: true,
    row: result.row,
    id: result.id,
    mode: 'apps-script',
    bukti: result.bukti
  });
}

function actDelete(b) {
  var sh = sheetTab(TAB);
  var result = withLock_(function () {
    ensureHeader(sh);
    var row = resolveRow_(sh, b);
    var old = sh.getRange(row, 1, 1, 10).getValues()[0] || [];
    sh.deleteRow(row);
    return { row: row, id: cleanId_(old[8]), keterangan: cleanText_(old[1], 160) };
  });

  return out({
    ok: true,
    row: result.row,
    id: result.id,
    mode: 'apps-script',
    keterangan: result.keterangan
  });
}

function actAngSave(b) {
  var kat = cleanText_(b.kat, 60);
  if (!kat) return out({ ok: false, code: 400, error: 'kategori kosong' });
  var t1 = Math.max(0, toNum(b.t1));
  var t2 = Math.max(0, toNum(b.t2));
  if (t1 > 1000000000000 || t2 > 1000000000000) {
    return out({ ok: false, code: 400, error: 'anggaran terlalu besar' });
  }

  var row = intVal(b.row);
  if (row === 1) return out({ ok: false, code: 400, error: 'baris judul tidak boleh diubah' });

  var sh = sheetTab(TAB_ANG);
  var savedRow = withLock_(function () {
    var items = readAnggaran();
    if (!row) {
      for (var i = 0; i < items.length; i++) {
        if (String(items[i].kat).toLowerCase() === kat.toLowerCase()) {
          throw new Error('kategori sudah ada: ' + items[i].kat);
        }
      }
      var maxRow = 1;
      for (var j = 0; j < items.length; j++) maxRow = Math.max(maxRow, items[j].row);
      row = maxRow + 1;
    } else {
      for (var k = 0; k < items.length; k++) {
        if (items[k].row !== row && String(items[k].kat).toLowerCase() === kat.toLowerCase()) {
          throw new Error('kategori sudah ada: ' + items[k].kat);
        }
      }
      if (row > sh.getLastRow()) throw new Error('baris anggaran tidak ditemukan');
    }
    sh.getRange(row, 1, 1, 3).setValues([[kat, rp(t1), rp(t2)]]);
    return row;
  });

  return out({ ok: true, row: savedRow, mode: 'apps-script', items: readAnggaran() });
}

function actAngDelete(b) {
  var row = intVal(b.row);
  if (row < 2) return out({ ok: false, code: 400, error: 'row tidak valid' });
  var sh = sheetTab(TAB_ANG);
  withLock_(function () {
    if (row > sh.getLastRow()) throw new Error('baris anggaran tidak ditemukan');
    sh.deleteRow(row);
  });
  return out({ ok: true, row: row, mode: 'apps-script', items: readAnggaran() });
}

/* ======================= AKSI MASTER DATA ======================= */

function actAkunSave(b) {
  var nama = cleanText_(b.nama, 40);
  if (!nama) return out({ ok: false, code: 400, error: 'Nama akun wajib diisi.' });
  var tipe = cleanText_(b.tipe, 20) || 'Aset';
  if (['Aset', 'Kewajiban', 'Piutang'].indexOf(tipe) < 0) tipe = 'Aset';
  var row = intVal(b.row);
  var aktif = boolVal_(b.aktif, true);
  var urutan = intVal(b.urutan);
  if (!urutan) urutan = 99;
  var defaultFlag = boolVal_(b.default, false) && aktif;
  var catatan = cleanText_(b.catatan, 200);
  var saldoAwal = toNum(b.saldoAwal);
  var sh = sheetTab(TAB_AKUN);

  var saved = withLock_(function () {
    var last = sh.getLastRow();
    if (last < 1) throw new Error('Tab Akun belum siap.');
    var oldName = '';
    if (row) {
      if (row < 2 || row > last) throw new Error('Akun tidak ditemukan.');
      oldName = cleanText_(sh.getRange(row, 1).getValue(), 40);
    }
    if (last > 1) {
      var vals = sh.getRange(2, 1, last - 1, 6).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (i + 2 === row) continue;
        if (String(vals[i][0] || '').trim().toLowerCase() === nama.toLowerCase()) {
          throw new Error('Nama akun sudah dipakai: ' + vals[i][0]);
        }
      }
      if (defaultFlag) {
        var defaults = sh.getRange(2, 5, last - 1, 1).getValues();
        for (var d = 0; d < defaults.length; d++) {
          defaults[d][0] = (d + 2 === row);
        }
        sh.getRange(2, 5, last - 1, 1).setValues(defaults);
      }
    }
    if (!row) row = lastDataRow(sh) + 1;
    sh.getRange(row, 1, 1, 6).setValues([[nama, tipe, aktif, urutan, defaultFlag, catatan]]);
    if (oldName && oldName !== nama) {
      replaceExact_(TAB_OPNAME, 2, oldName, nama);
      replaceExact_(TAB, 6, oldName, nama);
      replaceExact_(TAB, 8, oldName, nama);
    }
    if (!oldName) appendOpname_(nama, saldoAwal);
    return row;
  });

  return out({ ok: true, row: saved, mode: 'apps-script' });
}

function actAkunArchive(b) {
  var row = intVal(b.row);
  if (row < 2) return out({ ok: false, code: 400, error: 'row tidak valid' });
  var sh = sheetTab(TAB_AKUN);
  withLock_(function () {
    if (row > sh.getLastRow()) throw new Error('Akun tidak ditemukan.');
    sh.getRange(row, 3).setValue(false);
    sh.getRange(row, 5).setValue(false);
  });
  return out({ ok: true, row: row, mode: 'apps-script' });
}

function actKategoriSave(b) {
  var nama = cleanText_(b.nama, 60);
  if (!nama) return out({ ok: false, code: 400, error: 'Nama kategori wajib diisi.' });
  var tipe = cleanText_(b.tipe, 20) || 'Pengeluaran';
  if (['Pemasukan', 'Pengeluaran', 'Umum', 'Transfer', 'Hutang', 'Piutang'].indexOf(tipe) < 0) tipe = 'Pengeluaran';
  var kelompok = cleanText_(b.kelompok, 40);
  var aktif = boolVal_(b.aktif, true);
  var urutan = intVal(b.urutan);
  if (!urutan) urutan = 99;
  var row = intVal(b.row);
  var sh = sheetTab(TAB_KATEGORI);

  var saved = withLock_(function () {
    var last = sh.getLastRow();
    if (last < 1) throw new Error('Tab Kategori belum siap.');
    var oldName = '';
    if (row) {
      if (row < 2 || row > last) throw new Error('Kategori tidak ditemukan.');
      oldName = cleanText_(sh.getRange(row, 1).getValue(), 60);
    }
    if (last > 1) {
      var vals = sh.getRange(2, 1, last - 1, 5).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (i + 2 === row) continue;
        if (String(vals[i][0] || '').trim().toLowerCase() === nama.toLowerCase()) {
          throw new Error('Nama kategori sudah dipakai: ' + vals[i][0]);
        }
      }
    }
    if (oldName && oldName !== nama && budgetRowByName_(nama)) {
      throw new Error('Kategori anggaran dengan nama itu sudah ada. Gunakan Gabung.');
    }
    if (!row) row = lastDataRow(sh) + 1;
    sh.getRange(row, 1, 1, 5).setValues([[nama, tipe, kelompok, aktif, urutan]]);
    if (oldName && oldName !== nama) {
      replaceExact_(TAB, 3, oldName, nama);
      replaceExact_(TAB_ANG, 1, oldName, nama);
    }
    return row;
  });

  return out({ ok: true, row: saved, mode: 'apps-script' });
}

function actKategoriArchive(b) {
  var row = intVal(b.row);
  if (row < 2) return out({ ok: false, code: 400, error: 'row tidak valid' });
  var sh = sheetTab(TAB_KATEGORI);
  withLock_(function () {
    if (row > sh.getLastRow()) throw new Error('Kategori tidak ditemukan.');
    sh.getRange(row, 4).setValue(false);
  });
  return out({ ok: true, row: row, mode: 'apps-script' });
}

function budgetRowByName_(name) {
  var sh = sheetTab(TAB_ANG);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim().toLowerCase() === String(name || '').trim().toLowerCase()) return i + 2;
  }
  return 0;
}

function actKategoriMerge(b) {
  var from = cleanText_(b.from, 60);
  var to = cleanText_(b.to, 60);
  if (!from || !to) return out({ ok: false, code: 400, error: 'Kategori asal dan tujuan wajib diisi.' });
  if (from.toLowerCase() === to.toLowerCase()) return out({ ok: false, code: 400, error: 'Pilih kategori tujuan yang berbeda.' });
  var katSh = sheetTab(TAB_KATEGORI);
  var trSh = sheetTab(TAB);
  var angSh = sheetTab(TAB_ANG);

  var result = withLock_(function () {
    var katLast = katSh.getLastRow();
    if (katLast < 2) throw new Error('Kategori belum tersedia.');
    var katVals = katSh.getRange(2, 1, katLast - 1, 5).getValues();
    var fromRow = 0, toRow = 0;
    for (var i = 0; i < katVals.length; i++) {
      var n = String(katVals[i][0] || '').trim();
      if (n.toLowerCase() === from.toLowerCase()) fromRow = i + 2;
      if (n.toLowerCase() === to.toLowerCase()) toRow = i + 2;
    }
    if (!fromRow) throw new Error('Kategori asal tidak ditemukan.');
    if (!toRow) throw new Error('Kategori tujuan tidak ditemukan.');
    if (boolVal_(katVals[toRow - 2][3], true) === false) throw new Error('Kategori tujuan sedang diarsipkan.');

    var moved = replaceExact_(TAB, 3, from, to);

    var fromBudget = budgetRowByName_(from);
    var toBudget = budgetRowByName_(to);
    if (fromBudget) {
      if (toBudget) {
        var a = angSh.getRange(fromBudget, 1, 1, 3).getValues()[0];
        var t = angSh.getRange(toBudget, 1, 1, 3).getValues()[0];
        var total1 = toNum(t[1]) + toNum(a[1]);
        var total2 = toNum(t[2]) + toNum(a[2]);
        angSh.getRange(toBudget, 1, 1, 3).setValues([[to, rp(total1), rp(total2)]]);
        angSh.deleteRow(fromBudget);
      } else {
        angSh.getRange(fromBudget, 1).setValue(to);
      }
    }
    katSh.getRange(fromRow, 4).setValue(false);
    return { moved: moved, budgets: (fromBudget ? 1 : 0) + (toBudget ? 1 : 0) };
  });

  return out({ ok: true, mode: 'apps-script', moved: result.moved, budgets: result.budgets });
}

function actTargetSave(b) {
  var nama = cleanText_(b.nama, 80);
  if (!nama) return out({ ok: false, code: 400, error: 'Nama target wajib diisi.' });
  var goal = Math.max(0, Math.round(toNum(b.target)));
  var got = Math.max(0, Math.round(toNum(b.terkumpul)));
  if (goal > 1000000000000 || got > 1000000000000) return out({ ok: false, code: 400, error: 'Nominal target terlalu besar.' });
  var row = intVal(b.row);
  var status = cleanText_(b.status, 40) || 'Berjalan';
  var deadline = String(b.deadline || '').trim();
  if (deadline && !parseTextDate(deadline) && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return out({ ok: false, code: 400, error: 'Deadline tidak valid.' });
  }
  var sh = sheetTab(TAB_TABUNGAN);
  var progress = goal > 0 ? Math.round(got / goal * 10000) / 10000 : 0;
  var sisa = Math.max(0, goal - got);

  var saved = withLock_(function () {
    if (row) {
      if (row < 2 || row > sh.getLastRow()) throw new Error('Target tidak ditemukan.');
    } else {
      row = lastDataRow(sh) + 1;
    }
    var deadlineVal = deadline ? (parseTextDate(deadline) || deadline) : '';
    sh.getRange(row, 1, 1, 7).setValues([[
      nama, goal, got, sisa, progress, deadline ? tglObj(deadlineVal) : '', status
    ]]);
    sh.getRange(row, 2, 1, 3).setNumberFormat('#,##0');
    sh.getRange(row, 5).setNumberFormat('0.0%');
    if (deadline) sh.getRange(row, 6).setNumberFormat('dd MMM yyyy');
    return row;
  });

  return out({ ok: true, row: saved, mode: 'apps-script' });
}

function actTargetDelete(b) {
  var row = intVal(b.row);
  if (row < 2) return out({ ok: false, code: 400, error: 'row tidak valid' });
  var sh = sheetTab(TAB_TABUNGAN);
  withLock_(function () {
    if (row > sh.getLastRow()) throw new Error('Target tidak ditemukan.');
    sh.deleteRow(row);
  });
  return out({ ok: true, row: row, mode: 'apps-script' });
}

function actRencanaSave(b) {
  var jenis = cleanText_(b.jenis, 20) || 'Saving';
  if (jenis !== 'Baseline' && jenis !== 'Saving') jenis = 'Saving';
  var label = cleanText_(b.label, 80);
  if (!label) return out({ ok: false, code: 400, error: 'Label rencana wajib diisi.' });
  var nominal = Math.max(0, Math.round(toNum(b.nominal)));
  var catatan = cleanText_(b.catatan, 200);
  var warna = String(b.warna || '#4dabf7').trim();
  if (!/^#[0-9a-f]{6}$/i.test(warna)) warna = '#4dabf7';
  var urutan = intVal(b.urutan);
  if (!urutan) urutan = 99;
  var aktif = boolVal_(b.aktif, true);
  var row = intVal(b.row);
  var sh = sheetTab(TAB_RENCANA);

  var saved = withLock_(function () {
    var last = sh.getLastRow();
    if (last < 1) throw new Error('Tab Rencana belum siap.');
    if (jenis === 'Baseline') {
      var vals = last > 1 ? sh.getRange(2, 1, last - 1, 7).getValues() : [];
      var baselineRow = 0;
      for (var i = 0; i < vals.length; i++) {
        if (String(vals[i][0] || '').trim() === 'Baseline') { baselineRow = i + 2; break; }
      }
      row = baselineRow || (lastDataRow(sh) + 1);
      sh.getRange(row, 1, 1, 7).setValues([['Baseline', label, nominal, catatan, warna, 1, true]]);
      if (vals.length) {
        for (var j = 0; j < vals.length; j++) {
          if (j + 2 !== row && String(vals[j][0] || '').trim() === 'Baseline') {
            sh.getRange(j + 2, 7).setValue(false);
          }
        }
      }
      return row;
    }
    if (row) {
      if (row < 2 || row > last) throw new Error('Rencana tidak ditemukan.');
      if (String(sh.getRange(row, 1).getValue() || '').trim() === 'Baseline') {
        throw new Error('Baris baseline hanya bisa diubah lewat form baseline.');
      }
    } else {
      row = lastDataRow(sh) + 1;
    }
    sh.getRange(row, 1, 1, 7).setValues([[jenis, label, nominal, catatan, warna, urutan, aktif]]);
    return row;
  });

  return out({ ok: true, row: saved, mode: 'apps-script' });
}

function actRencanaDelete(b) {
  var row = intVal(b.row);
  if (row < 2) return out({ ok: false, code: 400, error: 'row tidak valid' });
  var sh = sheetTab(TAB_RENCANA);
  withLock_(function () {
    if (row > sh.getLastRow()) throw new Error('Rencana tidak ditemukan.');
    if (String(sh.getRange(row, 1).getValue() || '').trim() === 'Baseline') {
      throw new Error('Baseline tidak bisa dihapus; ubah nominalnya saja.');
    }
    sh.deleteRow(row);
  });
  return out({ ok: true, row: row, mode: 'apps-script' });
}

/* ======================= ID & IDEMPOTENSI ======================= */

function ensureHeader(sh) {
  var h1 = sh.getRange(1, 1, 1, 10).getValues()[0] || [];
  var changed = false;
  if (!String(h1[7] || '').trim()) { h1[7] = HDR_H; changed = true; }
  if (!String(h1[8] || '').trim()) { h1[8] = HDR_ID; changed = true; }
  if (!String(h1[9] || '').trim()) { h1[9] = HDR_REQ; changed = true; }
  if (changed) sh.getRange(1, 1, 1, 10).setValues([h1]);
}

function findRowById_(sh, id) {
  id = cleanId_(id);
  if (!id) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 9, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim() === id) return i + 2;
  }
  return 0;
}

function findByRequestId_(sh, req) {
  req = cleanRequestId_(req);
  if (!req) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 9, last - 1, 2).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][1] || '').trim() === req) {
      return { row: i + 2, id: String(vals[i][0] || '').trim() };
    }
  }
  return null;
}

function resolveRow_(sh, b) {
  var id = cleanId_(b.id);
  if (id) {
    var found = findRowById_(sh, id);
    if (!found) throw new Error('Transaksi tidak ditemukan. Muat ulang data lalu coba lagi.');
    return found;
  }
  var row = intVal(b.row);
  if (row < 2) throw new Error('row tidak valid');
  if (row > sh.getLastRow()) throw new Error('baris transaksi tidak ditemukan');
  return row;
}

/**
 * Jalankan manual sekali dari editor Apps Script setelah deploy, jika ingin
 * memberi ID permanen pada transaksi lama. Tidak dipanggil otomatis.
 */
function migrateTransactionIds() {
  var sh = sheetTab(TAB);
  var result = withLock_(function () {
    ensureHeader(sh);
    var last = sh.getLastRow();
    if (last < 2) return { updated: 0, total: 0 };
    var vals = sh.getRange(2, 9, last - 1, 1).getValues();
    var ids = [];
    var updated = 0;
    for (var i = 0; i < vals.length; i++) {
      var id = cleanId_(vals[i][0]);
      if (!id) {
        id = Utilities.getUuid();
        updated++;
      }
      ids.push([id]);
    }
    sh.getRange(2, 9, last - 1, 1).setValues(ids);
    return { updated: updated, total: last - 1 };
  });
  Logger.log('ID transaksi: ' + result.updated + ' baru dari ' + result.total + ' baris.');
  return result;
}

/**
 * Jalankan manual sekali untuk mencabut akses publik file bukti lama yang
 * sebelumnya dibuat dengan ANYONE_WITH_LINK. Tidak dipanggil otomatis.
 */
function revokePublicProofLinks() {
  var sh = sheetTab(TAB);
  var last = sh.getLastRow();
  if (last < 2) return { checked: 0, revoked: 0 };
  var vals = sh.getRange(2, 7, last - 1, 1).getValues();
  var checked = 0, revoked = 0, failed = 0;
  for (var i = 0; i < vals.length; i++) {
    var url = String(vals[i][0] || '');
    var m = /(?:id=|\/d\/)([A-Za-z0-9_-]{10,})/.exec(url);
    if (!m) continue;
    checked++;
    try {
      var file = DriveApp.getFileById(m[1]);
      file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      revoked++;
    } catch (e) {
      failed++;
    }
  }
  Logger.log('Bukti diperiksa: ' + checked + ', dicabut: ' + revoked + ', gagal: ' + failed);
  return { checked: checked, revoked: revoked, failed: failed };
}

/* ======================= VALIDASI ======================= */

function fields(b) {
  var tgl = String(b.tanggal || '').trim();
  var ket = cleanText_(b.keterangan, 160);
  var kat = cleanText_(b.kategori, 60) || 'Tanpa Kategori';
  var tipe = String(b.tipe || '').trim();
  var nom = toNum(b.nominal);
  var akun = cleanText_(b.akun, 40);
  var tujuan = cleanText_(b.akunTujuan, 60);

  if (!validIsoDate_(tgl)) return { error: 'tanggal harus berupa tanggal YYYY-MM-DD yang valid' };
  if (!ket) return { error: 'keterangan kosong' };
  if (VALID_TIPE.indexOf(tipe) < 0) return { error: 'tipe tidak valid' };
  if (!(nom > 0) || !isFinite(nom) || nom > 1000000000000) return { error: 'nominal harus > 0 dan wajar' };
  if (!akun) return { error: 'akun kosong' };
  if (tipe === 'Transfer' && !tujuan) return { error: 'akun tujuan wajib untuk transfer' };
  if (tipe === 'Transfer' && tujuan === akun) return { error: 'akun asal dan tujuan tidak boleh sama' };
  if (tipe === 'Pemasukan' || tipe === 'Pengeluaran' || tipe === 'Opname/Koreksi') tujuan = '';

  return { tgl: tgl, ket: ket, kat: kat, tipe: tipe, nom: nom, akun: akun, tujuan: tujuan };
}

function validIsoDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function cleanText_(v, max) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}

function cleanId_(v) {
  v = String(v === null || v === undefined ? '' : v).trim();
  return /^[A-Za-z0-9_-]{6,80}$/.test(v) ? v : '';
}

function cleanRequestId_(v) {
  v = String(v === null || v === undefined ? '' : v).trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(v) ? v : '';
}

/* ======================= PEMBANTU ======================= */

function prop_(key, fallback) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    return (v === null || v === '') ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function sheetId_() {
  return String(prop_('SHEET_ID', DEFAULT_SHEET_ID)).trim();
}

function folderName_() {
  return String(prop_('DRIVE_FOLDER', FOLDER_DEFAULT)).trim() || FOLDER_DEFAULT;
}

function pinConfig_() {
  var hash = String(prop_('PIN_HASH', '') || '').toLowerCase();
  var salt = String(prop_('PIN_SALT', '') || '');
  if (!/^[a-f0-9]{64}$/.test(hash) || !salt) return null;
  return { hash: hash, salt: salt };
}

function authVersion_() {
  return String(prop_('AUTH_VERSION', '1'));
}

function newAuthVersion_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function setupToken_() {
  var token = String(prop_('SETUP_TOKEN', '') || '').trim();
  if (token.length < MIN_SETUP_TOKEN_LENGTH) return '';
  return token;
}

/**
 * Jalankan sekali dari editor Apps Script untuk membuat kode setup acak.
 * Kode hanya ditampilkan di dialog editor dan disimpan di Script Properties,
 * tidak ditulis ke log atau dikirim ke chat.
 */
function BUAT_KODE_SETUP() {
  var code = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('SETUP_TOKEN', code);
  try {
    Browser.msgBox(
      'Kode setup PIN',
      'Masukkan kode ini di dashboard pada menu "Pertama kali? Buat PIN":\n\n' + code + '\n\nJangan bagikan kode ini. Setelah PIN dibuat, kode otomatis dihapus.',
      Browser.Buttons.OK
    );
  } catch (e) {
    Logger.log('SETUP_TOKEN sudah dibuat. Buka Project Settings > Script Properties untuk menyalin nilainya.');
  }
}

function pinOk(pin) {
  var cfg = pinConfig_();
  if (!cfg) return false;
  return h(String(pin || '') + '|' + cfg.salt) === cfg.hash;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function sheetTab(name) {
  var sh = SpreadsheetApp.openById(sheetId_()).getSheetByName(name);
  if (!sh) throw new Error('tab tidak ada: ' + name);
  return sh;
}

function lastDataRow(sh) {
  var last = sh.getLastRow();
  if (last < 1) return 1;
  var col = sh.getRange(1, 1, last, 1).getValues();
  for (var i = col.length - 1; i >= 1; i--) {
    if (String(col[i][0]).trim() !== '') return i + 1;
  }
  return 1;
}

function formatRow(sh, row) {
  sh.getRange(row, 1).setNumberFormat('dd MMM yyyy');
  sh.getRange(row, 5).setNumberFormat('#,##0');
}

function tglObj(iso) {
  var p = String(iso).split('-');
  // 05:00 UTC = 12:00 Asia/Jakarta; tidak bergantung timezone project.
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 5, 0, 0));
}

function isoOf(v) {
  var tag = Object.prototype.toString.call(v);
  if (tag === '[object Date]') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  if (typeof v === 'number') {
    var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  return parseTextDate(String(v || ''));
}

var BULAN = {
  jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6,
  jul: 7, agu: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12
};

function parseTextDate(s) {
  var m = /^(\d{1,2})[\s\/-]([A-Za-z]+|\d{1,2})[\s\/-](\d{4})$/.exec(String(s).trim());
  if (!m) return '';
  var dd = Number(m[1]);
  var mm = /^\d+$/.test(m[2]) ? Number(m[2]) : (BULAN[m[2].slice(0, 3).toLowerCase()] || 0);
  var yy = Number(m[3]);
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return '';
  var dt = new Date(Date.UTC(yy, mm - 1, dd, 5, 0, 0));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return '';
  return Utilities.formatDate(dt, TZ, 'yyyy-MM-dd');
}

function toNum(v) {
  if (typeof v === 'number') return v;
  var s = String(v === null || v === undefined ? '' : v).replace(/[^0-9,.\-]/g, '');
  if (!s) return 0;
  if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  var n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function intVal(v) {
  var n = parseInt(v, 10);
  return isFinite(n) ? n : 0;
}

function rp(v) {
  var n = Math.round(toNum(v));
  return 'Rp ' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function upload(b64, name, tgl, ket) {
  var clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!clean) throw new Error('data bukti kosong');
  if (clean.length > 8 * 1024 * 1024) throw new Error('ukuran bukti terlalu besar');
  var blob = Utilities.newBlob(Utilities.base64Decode(clean));
  var ext = 'jpg';
  var m = /\.(png|jpe?g|webp|heic)$/i.exec(String(name || ''));
  if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  var safe = String(ket).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  blob.setName('bukti_' + String(tgl).replace(/-/g, '') + '_' + (safe || 'trx') + '.' + ext);
  var it = DriveApp.getFoldersByName(folderName_());
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName_());
  var file = folder.createFile(blob);
  // Sengaja tidak memanggil setSharing: file tetap privat bagi pemilik Drive.
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function h(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    }).join('');
}

function nowStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function msg(err) {
  return String(err && err.message ? err.message : err);
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
