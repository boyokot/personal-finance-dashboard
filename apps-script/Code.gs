var SHEET_ID = '1JJKxdmyq-dbochsEUEo8-zqE7rzXihU6fj-7sLgCNKE';
var TAB = 'Transaksi';
var PIN_HASH = '389b3cd1d341d7bb027f06db3f3db28200de4e2933820e75de3aa1326d023629';
var SALT = 'pf-dashboard-2026';
var FOLDER = 'Bukti Keuangan Pribadi';

function doGet(e) {
  return out({ ok: true, service: 'keuangan-pribadi' });
}

function doPost(e) {
  try {
    var b = JSON.parse(e.postData.contents);
    if (h(String(b.pin || '') + '|' + SALT) !== PIN_HASH) return out({ ok: false, error: 'PIN salah' });

    var tgl = String(b.tanggal || '');
    var ket = String(b.keterangan || '').trim();
    var kat = String(b.kategori || 'Tanpa Kategori').trim();
    var tipe = String(b.tipe || '').trim();
    var nom = num(b.nominal);
    var akun = String(b.akun || '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) return out({ ok: false, error: 'tanggal harus YYYY-MM-DD' });
    if (!ket) return out({ ok: false, error: 'keterangan kosong' });
    if (['Pemasukan', 'Pengeluaran', 'Transfer', 'Piutang', 'Hutang', 'Opname/Koreksi'].indexOf(tipe) < 0) return out({ ok: false, error: 'tipe tidak valid' });
    if (!(nom > 0)) return out({ ok: false, error: 'nominal harus > 0' });
    if (!akun) return out({ ok: false, error: 'akun kosong' });

    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB);
    var bukti = '';
    if (b.buktiBase64) bukti = upload(b.buktiBase64, b.buktiName, tgl, ket);

    var row = lastRow(sh) + 1;
    sh.getRange(row, 1, 1, 7).setValues([[tglObj(tgl), ket, kat, tipe, nom, akun, bukti]]);
    sh.getRange(row, 1).setNumberFormat('dd MMM yyyy');
    sh.getRange(row, 5).setNumberFormat('#,##0');

    return out({ ok: true, row: row, tanggal: tgl, keterangan: ket, tipe: tipe, nominal: nom, akun: akun, bukti: bukti });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function num(v) {
  if (typeof v === 'number') return v;
  var s = String(v || '').replace(/[^0-9,.\-]/g, '');
  if (!s) return 0;
  if (s.indexOf(',') > s.indexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  var n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function tglObj(iso) {
  var p = iso.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
}

function lastRow(sh) {
  var last = sh.getLastRow();
  if (last < 2) return 1;
  var v = sh.getRange(1, 1, last, 1).getValues();
  for (var i = v.length - 1; i >= 1; i--) if (String(v[i][0]).trim() !== '') return i + 1;
  return 1;
}

function upload(b64, name, tgl, ket) {
  var clean = String(b64).replace(/^data:[^;]+;base64,/, '');
  var blob = Utilities.newBlob(Utilities.base64Decode(clean));
  var ext = 'jpg';
  var m = /\.(png|jpe?g|webp|heic)$/i.exec(String(name || ''));
  if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  var safe = String(ket).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  blob.setName('bukti_' + tgl.replace(/-/g, '') + '_' + (safe || 'trx') + '.' + ext);
  var it = DriveApp.getFoldersByName(FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function h(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
