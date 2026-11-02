# Keamanan Apps Script — Phase 1

Dokumen ini adalah panduan manual untuk memasang backend `Code.gs` yang sudah
diperketat. Frontend **tidak boleh** di-merge/deploy sebelum langkah backend di
bawah selesai.

## Yang berubah

- PIN tidak lagi ditulis di source. `PIN_HASH` dan `PIN_SALT` dibaca dari
  **Script Properties**.
- Login memakai `POST /exec` dengan body JSON; PIN tidak pernah dikirim di URL.
- Baca data memakai token sesi (6 jam) melalui `POST {action:"data"}`.
- Semua aksi tulis memerlukan token sesi **dan** PIN.
- Login dibatasi 5 percobaan gagal per 15 menit.
- Upload bukti baru disimpan privat; tidak ada lagi `ANYONE_WITH_LINK`.
- Transaksi baru mendapat kolom `ID` dan `Request ID` untuk update/delete yang
  aman dan retry idempoten.
- CSV publik tidak lagi dipakai oleh dashboard.

## 1. Buat hash PIN (di komputer sendiri)

Jangan pernah mengirim PIN ke chat atau menyimpannya di repo. Jalankan dari
terminal lokal:

```bash
python3 apps-script/generate-pin-config.py
```

Atau secara manual:

```bash
python3 - <<'PY'
import getpass, hashlib, secrets
pin = getpass.getpass('PIN 6 angka: ')
salt = secrets.token_hex(16)
print('PIN_SALT =', salt)
print('PIN_HASH =', hashlib.sha256((pin + '|' + salt).encode()).hexdigest())
PY
```

Simpan hasilnya hanya di Script Properties Apps Script.

## 2. Pasang Code.gs

1. Buka spreadsheet → **Extensions → Apps Script**.
2. Ganti isi `Code.gs` dengan file `apps-script/Code.gs` dari branch ini.
3. Buka **Project Settings**:
   - Timezone: `Asia/Jakarta`.
4. Buka **Project Settings → Script Properties**, tambahkan:
   - `PIN_HASH` = hash dari langkah 1
   - `PIN_SALT` = salt dari langkah 1
   - opsional `SHEET_ID` bila spreadsheet berbeda
   - opsional `DRIVE_FOLDER` (default `Bukti Keuangan Pribadi`)
5. Simpan.

> **Gunakan PIN baru.** Hash PIN lama pernah tercatat di riwayat commit
> sebelumnya. Jangan memakai PIN lama setelah backend baru dipasang.

## 3. Deploy versi baru

Lakukan deploy backend dan frontend berdekatan (idealnya saat tidak sedang
mencatat transaksi). Frontend lama tidak bisa menulis ke backend baru, dan
frontend baru tidak bisa membaca backend lama.


1. **Deploy → Manage deployments**.
2. Pilih deployment web app yang dipakai dashboard → **Edit**.
3. Version: **New version**.
4. Execute as: **Me**.
5. Who has access: **Anyone** (login tetap diperlukan di aplikasi).
6. Deploy.
7. Jika URL `/exec` berubah, perbarui `endpoint.txt` dan `latest.html` bila
   diperlukan.

## 4. Cabut publikasi lama

Ini wajib agar data lama tidak tetap dapat dibaca publik:

1. Di spreadsheet: **File → Share → Publish to web → Stop publishing**.
2. Di Google Drive, pastikan folder `Bukti Keuangan Pribadi` tidak dibagikan
   ke "anyone with the link".
3. Jalankan fungsi `revokePublicProofLinks()` sekali dari editor Apps Script
   untuk mencabut sharing file bukti lama yang URL-nya tercatat di sheet.
4. Jalankan `migrateTransactionIds()` sekali agar transaksi lama mendapat ID
   permanen. Fungsi ini hanya mengisi kolom ID yang masih kosong.

## 5. Verifikasi

- Buka `.../exec?action=ping` → harus `ok:true` dan `configured:true`.
- Buka `.../exec?action=list&pin=...` → harus ditolak `405` (bukan data).
- Login dari dashboard dengan PIN yang benar.
- Coba PIN salah 5 kali → harus muncul pesan batas percobaan.
- Buka `spending-limit.html` dari sesi dashboard yang sama.
- Pastikan tidak ada request ke `docs.google.com/spreadsheets/.../pub` di
  Network tab.
- Pastikan file bukti baru tidak dapat dibuka di jendela private/incognito.

## 6. Frontend

Setelah backend terpasang dan diuji:

- Deploy `index.html`, `spending-limit.html`, `endpoint.txt`, dan `latest.html`
  dari branch `security-financial-fix`.
- Cache GitHub Pages bisa sampai 10 menit; gunakan `latest.html` atau query
  `?v=...` untuk memastikan versi baru.
- Jangan memasukkan PIN, hash, salt, token, atau isi transaksi ke issue/log.
