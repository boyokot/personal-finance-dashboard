#!/usr/bin/env python3
"""Membuat PIN_SALT dan PIN_HASH untuk Script Properties Apps Script.

PIN dibaca tersembunyi, tidak ditulis ke disk, dan tidak dikirim ke mana pun.
Jalankan dari terminal lokal, lalu salin hasilnya ke Script Properties.
"""

import getpass
import hashlib
import secrets


def main() -> None:
    pin = getpass.getpass("PIN 6 angka: ").strip()
    if not (len(pin) == 6 and pin.isdigit()):
        raise SystemExit("PIN harus tepat 6 angka.")
    confirm = getpass.getpass("Ulangi PIN: ").strip()
    if pin != confirm:
        raise SystemExit("PIN tidak sama.")

    salt = secrets.token_hex(16)
    digest = hashlib.sha256((pin + "|" + salt).encode("utf-8")).hexdigest()
    print("\nSalin dua baris ini ke Script Properties Apps Script:")
    print("PIN_SALT =", salt)
    print("PIN_HASH =", digest)


if __name__ == "__main__":
    main()
