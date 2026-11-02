# Keamanan Apps Script — Phase 1

Dokumen ini adalah panduan manual untuk memasang backend `Code.gs` yang sudah
diperketat. Frontend **tidak boleh** di-merge/deploy sebelum langkah backend di
bawah selesai.

## Urutan aman (jangan dibalik)

1. Pasang `Code.gs` di Apps Script, atur timezone, lalu deploy backend versi baru.
2. Segera merge/deploy frontend baru.
3. Buka dashboard, klik **Pertama kali? Buat PIN**, masukkan kode setup sekali
   pakai + PIN baru. PIN pertama akan disimpan sebagai hash di Script Properties.
4. Login dan pastikan data terbaca.
5. Baru hentikan **Publish to web**, buat folder bukti privat, dan jalankan
   `revokePublicProofLinks()` / `migrateTransactionIds()`.
6. Jangan mencatat transaksi selama pergantian; frontend lama tidak bisa
   menulis ke backend baru.

## Yang berubah

- PIN tidak lagi ditulis di source. Setelah setup, `PIN_HASH` dan `PIN_SALT`
  disimpan di **Script Properties**.
- Setup PIN pertama memakai `SETUP_TOKEN` sementara di Script Properties.
  Token dihapus otomatis setelah PIN berhasil dibuat; tidak ada PIN, hash,
  atau token yang dikirim ke chat, Telegram, log, atau repo.
- Login memakai `POST /exec` dengan body JSON; PIN tidak pernah dikirim di URL.
- Baca data memakai token sesi (6 jam) melalui `POST {action:"data"}`.
- Semua aksi tulis memerlukan token sesi **dan** PIN.
- Login dibatasi 5 percobaan gagal per 15 menit. Setup PIN juga dibatasi 5
  percobaan kode salah per 15 menit.
- **Ubah PIN** tersedia di **Pengaturan → PIN dashboard**. Perubahan PIN
  membutuhkan PIN sekarang, lalu mencabut semua sesi lama lewat `AUTH_VERSION`.
- Upload bukti baru disimpan privat; tidak ada lagi `ANYONE_WITH_LINK`.
- Transaksi baru mendapat kolom `ID` dan `Request ID` untuk update/delete yang
  aman dan retry idempoten.
- CSV publik tidak lagi dipakai oleh dashboard.

## 1. Pasang Code.gs

1. Buka spreadsheet → **Extensions → Apps Script**.
2. Ganti isi `Code.gs` dengan file `apps-script/Code.gs` dari branch ini.
3. Buka **Project Settings**:
   - Timezone: `Asia/Jakarta`.
4. Buat kode setup sementara. Pilih salah satu:
   - Jalankan fungsi `BUAT_KODE_SETUP()` dari editor, lalu salin kode yang
     muncul di dialog. Fungsi ini menyimpan kode di `SETUP_TOKEN` dan tidak
     menuliskannya ke log; atau
   - Tambahkan Script Property `SETUP_TOKEN` berisi kode acak pilihan Anda
     (minimal 20 karakter). Jangan memakai PIN sebagai kode setup.
5. Simpan.

> **Gunakan PIN baru.** Hash PIN lama pernah tercatat di riwayat commit
> sebelumnya. Jangan memakai PIN lama setelah backend baru dipasang.

## 2. Deploy versi baru

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

## 3. Buat PIN pertama dari dashboard

1. Buka halaman login dashboard versi baru.
2. Klik **Pertama kali? Buat PIN**.
3. Masukkan **kode setup** dari `SETUP_TOKEN` dan PIN baru 6 angka (dua kali).
4. Setelah berhasil, dashboard otomatis login, `SETUP_TOKEN` dihapus, dan PIN
   disimpan sebagai hash di Script Properties. Endpoint setup akan menolak
   permintaan berikutnya dengan `409`.
5. Jangan membagikan kode setup. Setelah PIN dibuat, kode tidak bisa dipakai
   lagi; gunakan **Pengaturan → PIN dashboard** untuk mengganti PIN.

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

- Sebelum setup: buka `.../exec?action=ping` → `ok:true` dan
  `configured:false`.
- Setelah setup: ping harus `configured:true`; login dengan PIN baru.
- Buka `.../exec?action=list&pin=...` → harus ditolak `405` (bukan data).
- Coba PIN salah 5 kali → harus muncul pesan batas percobaan.
- Ubah PIN di Pengaturan, lalu pastikan token lama tidak bisa membaca data dan
  login dengan PIN lama gagal.
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

## 7. Jika PIN lupa atau kode setup hilang

- **Lupa PIN**: dari editor Apps Script, hapus properti `PIN_HASH`, `PIN_SALT`,
  dan `AUTH_VERSION`, lalu buka dashboard dan lakukan setup PIN sekali pakai
  lagi. Ini mencabut semua sesi lama.
- **Kode setup hilang**: buat kode baru dengan menjalankan
  `BUAT_KODE_SETUP()` atau mengisi ulang `SETUP_TOKEN`, lalu ulangi setup.
  Jangan meminta kode dikirim lewat chat publik.
- **Fallback manual**: `apps-script/generate-pin-config.py` masih bisa dipakai
  untuk mengisi `PIN_SALT`/`PIN_HASH` langsung dari editor, tetapi PIN akan
  diketik di terminal lokal, bukan dashboard.
- Jangan pernah mengirim PIN, hash, salt, token, atau kode setup ke issue,
  log, atau repo.
