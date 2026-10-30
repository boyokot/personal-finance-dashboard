/**
 * Penulis Keuangan Pribadi versi Google Apps Script (tanpa server HP).
 *
 * Cara panggil (dipakai dashboard):
 *   GET  .../exec?action=ping
 *   GET  .../exec?action=list&n=300&pin=xxxxxx
 *   GET  .../exec?action=anggaran
 *   POST .../exec   body JSON { action, pin, ... }
 *        action = add | update | delete | anggaran/save | anggaran/delete
 *
 * Semua aksi tulis wajib PIN (SHA-256 + SALT), sama seperti server.py.
 */

var SHEET_ID = '1JJKxdmyq-dbochsEUEo8-zqE7rzXihU6fj-7sLgCNKE';
var TAB = 'Transaksi';
var TAB_ANG = 'Anggaran';
var PIN_HASH = '389b3cd1d341d7bb027f06db3f3db28200de4e2933820e75de3aa1326d023629';
var SALT = 'pf-dashboard-2026';
var FOLDER = 'Bukti Keuangan Pribadi';
var HDR_H = 'Akun Tujuan / Pihak';
var VALID_TIPE = ['Pemasukan', 'Pengeluaran', 'Transfer', 'Piutang', 'Hutang', 'Opname/Koreksi'];

/* ======================= ROUTER ======================= */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || 'ping').replace(/^\//, '');
  try {
    if (action === 'ping' || action === '') {
      return out({ ok: true, service: 'keuangan-pribadi', mode: 'apps-script', time: nowStr() });
    }
    if (!pinOk(p.pin)) return out({ ok: false, code: 403, error: 'PIN salah' });
    if (action === 'list') return out({ ok: true, items: listRows(p.n) });
    if (action === 'anggaran') return out({ ok: true, items: readAnggaran() });
    return out({ ok: false, error: 'action tidak dikenal: ' + action });
  } catch (err) {
    return out({ ok: false, error: msg(err) });
  }
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    var b = JSON.parse(raw);
    if (!pinOk(b.pin)) return out({ ok: false, code: 403, error: 'PIN salah' });

    var action = String(b.action || 'add').replace(/^\//, '');

    if (action === 'add') return actAdd(b);
    if (action === 'update') return actUpdate(b);
    if (action === 'delete') return actDelete(b);
    if (action === 'anggaran/save') return actAngSave(b);
    if (action === 'anggaran/delete') return actAngDelete(b);
    return out({ ok: false, error: 'action tidak dikenal: ' + action });
  } catch (err) {
    return out({ ok: false, error: msg(err) });
  }
}

/* ======================= AKSI TULIS ======================= */

function actAdd(b) {
  var f = fields(b);
  if (f.error) return out({ ok: false, error: f.error });

  var sh = sheetTab(TAB);
  ensureHeader(sh);

  var bukti = '';
  if (b.buktiBase64) bukti = upload(b.buktiBase64, b.buktiName, f.tgl, f.ket);

  var row = lastDataRow(sh) + 1;
  sh.getRange(row, 1, 1, 8).setValues([[
    tglObj(f.tgl), f.ket, f.kat, f.tipe, f.nom, f.akun, bukti, f.tujuan
  ]]);
  formatRow(sh, row);

  return out({
    ok: true, row: row, mode: 'apps-script',
    tanggal: f.tgl, keterangan: f.ket, kategori: f.kat, tipe: f.tipe,
    nominal: f.nom, akun: f.akun, akunTujuan: f.tujuan, bukti: bukti
  });
}

function actUpdate(b) {
  var row = intVal(b.row);
  if (row < 2) return out({ ok: false, error: 'row tidak valid' });

  var f = fields(b);
  if (f.error) return out({ ok: false, error: f.error });

  var sh = sheetTab(TAB);
  var old = sh.getRange(row, 1, 1, 8).getValues()[0] || [];
  var bukti = String(old[6] || '').trim();
  if (b.hapusBukti) bukti = '';
  if (b.buktiBase64) bukti = upload(b.buktiBase64, b.buktiName, f.tgl, f.ket);

  sh.getRange(row, 1, 1, 8).setValues([[
    tglObj(f.tgl), f.ket, f.kat, f.tipe, f.nom, f.akun, bukti, f.tujuan
  ]]);
  formatRow(sh, row);

  return out({ ok: true, row: row, mode: 'apps-script', bukti: bukti });
}

function actDelete(b) {
  var row = intVal(b.row);
  if (row < 2) return out({ ok: false, error: 'row tidak valid' });

  var sh = sheetTab(TAB);
  var old = sh.getRange(row, 1, 1, 8).getValues()[0] || [];
  sh.deleteRow(row);

  return out({ ok: true, row: row, mode: 'apps-script', keterangan: String(old[1] || '') });
}

function actAngSave(b) {
  var row = intVal(b.row);
  if (row === 1) return out({ ok: false, error: 'baris judul tidak boleh diubah' });

  var kat = String(b.kat || '').trim().slice(0, 40);
  if (!kat) return out({ ok: false, error: 'kategori kosong' });
  var t1 = Math.max(0, toNum(b.t1));
  var t2 = Math.max(0, toNum(b.t2));

  var sh = sheetTab(TAB_ANG);
  var items = readAnggaran();

  if (!row) {
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].kat).toLowerCase() === kat.toLowerCase()) {
        return out({ ok: false, error: 'kategori sudah ada: ' + items[i].kat });
      }
    }
    var maxRow = 1;
    for (var j = 0; j < items.length; j++) maxRow = Math.max(maxRow, items[j].row);
    row = maxRow + 1;
  }

  sh.getRange(row, 1, 1, 3).setValues([[kat, rp(t1), rp(t2)]]);
  return out({ ok: true, row: row, mode: 'apps-script', items: readAnggaran() });
}

function actAngDelete(b) {
  var row = intVal(b.row);
  if (row < 2) return out({ ok: false, error: 'row tidak valid' });
  sheetTab(TAB_ANG).deleteRow(row);
  return out({ ok: true, row: row, mode: 'apps-script', items: readAnggaran() });
}

/* ======================= BACA DATA ======================= */

function listRows(n) {
  var sh = sheetTab(TAB);
  var last = sh.getLastRow();
  if (last < 2) return [];

  var vals = sh.getRange(2, 1, last - 1, 8).getValues();
  var outItems = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (!r[0] || String(r[0]).trim() === '') continue;
    var tipe = String(r[3] || '').trim();
    if (VALID_TIPE.indexOf(tipe) < 0) continue;
    outItems.push({
      row: i + 2,
      tanggal: isoOf(r[0]),
      tanggalTampil: isoOf(r[0]),
      keterangan: String(r[1] || '').trim(),
      kategori: String(r[2] || '').trim(),
      tipe: tipe,
      nominal: toNum(r[4]),
      akun: String(r[5] || '').trim(),
      bukti: String(r[6] || '').trim(),
      akunTujuan: String(r[7] || '').trim()
    });
  }
  outItems.sort(function (a, b) { return b.row - a.row; });

  var lim = intVal(n);
  if (!lim || lim < 1) lim = 30;
  if (lim > 300) lim = 300;
  return outItems.slice(0, lim);
}

function readAnggaran() {
  var sh = sheetTab(TAB_ANG);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 3).getValues();
  var items = [];
  for (var i = 0; i < vals.length; i++) {
    var kat = String(vals[i][0] || '').trim();
    if (!kat) continue;
    items.push({ row: i + 2, kat: kat, t1: toNum(vals[i][1]), t2: toNum(vals[i][2]) });
  }
  return items;
}

/* ======================= PEMBANTU ======================= */

function fields(b) {
  var tgl = String(b.tanggal || '').trim();
  var ket = String(b.keterangan || '').trim();
  var kat = String(b.kategori || '').trim() || 'Tanpa Kategori';
  var tipe = String(b.tipe || '').trim();
  var nom = toNum(b.nominal);
  var akun = String(b.akun || '').trim();
  var tujuan = String(b.akunTujuan || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) return { error: 'tanggal harus YYYY-MM-DD' };
  if (!ket) return { error: 'keterangan kosong' };
  if (VALID_TIPE.indexOf(tipe) < 0) return { error: 'tipe tidak valid' };
  if (!(nom > 0)) return { error: 'nominal harus > 0' };
  if (!akun) return { error: 'akun kosong' };
  if (tipe === 'Transfer' && !tujuan) return { error: 'akun tujuan wajib untuk transfer' };
  if (tipe === 'Transfer' && tujuan === akun) return { error: 'akun asal dan tujuan tidak boleh sama' };

  return { tgl: tgl, ket: ket, kat: kat, tipe: tipe, nom: nom, akun: akun, tujuan: tujuan };
}

function pinOk(pin) {
  return h(String(pin || '') + '|' + SALT) === PIN_HASH;
}

function sheetTab(name) {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
  if (!sh) throw new Error('tab tidak ada: ' + name);
  return sh;
}

function ensureHeader(sh) {
  var h1 = sh.getRange(1, 1, 1, 8).getValues()[0] || [];
  if (!String(h1[7] || '').trim()) sh.getRange(1, 8).setValue(HDR_H);
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
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
}

function isoOf(v) {
  var tag = Object.prototype.toString.call(v);
  if (tag === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
  return Utilities.formatDate(new Date(yy, mm - 1, dd, 12, 0, 0), Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
  var clean = String(b64).replace(/^data:[^;]+;base64,/, '');
  var blob = Utilities.newBlob(Utilities.base64Decode(clean));
  var ext = 'jpg';
  var m = /\.(png|jpe?g|webp|heic)$/i.exec(String(name || ''));
  if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  var safe = String(ket).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  blob.setName('bukti_' + String(tgl).replace(/-/g, '') + '_' + (safe || 'trx') + '.' + ext);
  var it = DriveApp.getFoldersByName(FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
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
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function msg(err) {
  return String(err && err.message ? err.message : err);
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
