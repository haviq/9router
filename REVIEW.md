# Review — 11 commit di fork Plinian

Dokumen ini untuk direview manual. Isinya apa yang **terverifikasi**, apa yang **belum**, dan di mana risikonya. Tidak ada klaim yang tidak bisa dicek ulang dengan perintah di bawah.

---

## Ringkasan commit

| Commit | Isi | File utama |
|---|---|---|
| `2a3ff77` | Token estimate per model family | `open-sse/rtk/tokenEstimate.js`, `open-sse/handlers/chatCore.js` |
| `5e73c53` | Fix combo health di `/v1/models` (2 bug) | `src/app/api/v1/models/route.js` |
| `300c514` | Provider Health panel | `src/lib/db/repos/requestDetailsRepo.js`, `src/app/api/providers/health/route.js`, `src/app/(dashboard)/dashboard/health/*` |
| `417a0a1` | Payload scorer | `open-sse/payload/payloadScorer.js` |
| `6848143` | Payload runner | `open-sse/payload/payloadRunner.js` |
| `462f972` | Payload benchmark API | `src/app/api/developer/payload-benchmark/route.js` |
| `e9abe06` | Benchmark tab UI | `src/app/(dashboard)/dashboard/developer/BenchmarkClient.js` |
| `3f38dc6` | Badge seat mati di Combo list | `src/app/(dashboard)/dashboard/combos/page.js` |
| `6b879b4` | Fix dev tunnel (`allowedDevOrigins`) | `next.config.mjs` |
| `e85cfd4` | Combo auto-heal | `src/lib/comboHeal.js`, `src/app/api/combos/heal/route.js`, `combos/page.js` |
| `8240b28` | Init dev branch | — |

---

## Status verifikasi

### Terverifikasi

**78 test, 6 suite, semua pass.**

```bash
cd tests && npx vitest run \
  unit/combo-heal.test.js \
  unit/payload-scorer.test.js \
  unit/payload-runner.test.js \
  unit/token-estimate-family.test.js \
  unit/v1-models-combo-liveness.test.js \
  unit/provider-health.test.js
```

**ESLint bersih** untuk semua file yang disentuh (0 error).

**Route baru hidup** — diverifikasi via HTTP saat dev server jalan:
```
/api/providers/health              401 (guard jalan)
/api/developer/payload-benchmark   401 (guard jalan)
/dashboard/health                  307 (redirect ke login)
```

**Import runtime** (tanpa bundler):
```
payloadScorer -> VERDICT, aggregateRuns, scoreResponse          ok
payloadRunner -> DEFAULT_RUNS, MAX_RUNS, resolvePayloadText,
                 runPayload, runPayloadMatrix                   ok
```

**Catalog payload**: 40/40 row resolve ke teks nyata, 0 unresolved.

### Belum terverifikasi — jujur

**1. Production build tidak selesai di container ini.**

`npm run build` butuh ~7GB RAM. Container sisa ~1.9GB. Build mati sebelum menulis log. Ini batas environment, bukan kode — tapi artinya **belum ada bukti bundle production compile**. Perlu dijalankan di mesin/VPS dengan RAM cukup:

```bash
npm run build
```

**2. `src/lib/comboHeal.js` tidak bisa di-import lewat `node` mentah.**

Error: `Cannot find package '@/shared'`. Itu alias `jsconfig.json` yang hanya di-resolve bundler dan vitest — bukan bug. Buktinya: 16 test combo-heal pass lewat vitest dengan alias yang sama.

**3. UI belum diklik manual.**

Semua halaman baru (Provider Health, Benchmark tab, Heal Combos) belum diuji lewat browser. Yang terverifikasi hanya: route merespons, lint bersih, unit test pass. Perilaku React-nya belum dilihat mata.

**4. Payload benchmark belum pernah dijalankan ke model nyata.**

Scorer dan runner diuji dengan transport stub. Route-nya belum pernah benar-benar memanggil provider. Butuh API key aktif di Endpoint settings.

---

## Temuan yang layak direview

### 1. Dua bug nyata di `/v1/models` (`5e73c53`)

**Bug A — ReferenceError.** Branch DB-unavailable memanggil `aliasToProviderId` yang tidak pernah didefinisikan. Crash total begitu DB mengembalikan array kosong. Yang benar `ALIAS_TO_ID` (sudah di-import). Sisa rename.

**Bug B — fail-open.** `canJudgeComboHealth` dihitung dari array yang sudah difilter `isActive`. Provider dimatikan semua = state valid, tapi panjang array 0 dibaca sebagai "DB mati" → gate fail-open → combo mati muncul lagi. Fix: hitung raw rows sebelum filter.

**Cara cek:** buka `src/app/api/v1/models/route.js`, lihat `rawConnectionCount` dan baris `const canJudgeComboHealth = rawConnectionCount > 0;`.

### 2. Bug di kode gue sendiri, ketangkep test (`e85cfd4`)

`buildLiveAliases` versi pertama pakai `||` berantai: custom prefix menimpa alias default. Akibatnya combo lama yang menulis `ds/model` akan dianggap mati dan **dihapus padahal provider-nya hidup**. Test `honours a custom prefix alongside the defaults` gagal, fix: daftarkan semua bentuk (prefix + alias + raw id).

**Ini kelas bug yang paling berbahaya di fitur ini** — auto-heal yang salah tebak menghapus seat yang berfungsi.

### 3. `load()` → `fetchData()` (`e85cfd4`)

Handler heal memanggil `load()` yang tidak ada. Fungsi asli `fetchData()`. Ketangkep sebelum commit lewat grep. Kalau lolos, tombol Apply akan throw ReferenceError setelah menulis DB.

### 4. Latency di Provider Health adalah sample, bukan sensus

Latency hidup di dalam JSON blob, bukan kolom SQL. Agregasi exact berarti deserialize seluruh row dalam window — ratusan MB di instance sibuk. Jadi:

- count → SQL exact (index `provider`, `status`)
- p50/p95/max → sample row terbaru, dibatasi 2000
- response melaporkan `sampledRows`, `latencySampleCap`, `latencyCoverage`
- UI menulis "sample, not census"

**Yang perlu dicek reviewer:** apakah batas 400 default terlalu kecil untuk instance lo.

### 5. Auto-heal sengaja tidak mengosongkan combo

Combo yang semua seat-nya mati **dilaporkan, tidak dikosongkan**. Model list kosong terlihat identik dengan combo baru dan menyembunyikan fakta provider-nya hilang. Keputusan itu diambil sadar — kalau lo mau perilaku lain, ubah `wouldEmpty` di `planComboHeal`.

### 6. Dry-run adalah default

`POST /api/combos/heal` tanpa body = dry run. Harus eksplisit `{dryRun: false}` untuk menulis. Healing menulis ulang row tersimpan; operator yang cuma mau preview tidak boleh menemukan list berubah karena satu klik.

---

## Yang perlu dicek reviewer

**Keamanan**
- `INITIAL_PASSWORD=change-me` masih di `.env`. Ganti sebelum instance ini reachable dari internet.
- Route baru semuanya di bawah `/api/*` → kena `dashboardGuard` (JWT wajib). Diverifikasi 401 tanpa auth.
- `payload-benchmark` bisa memicu request keluar berbayar. Batas: 8 payload × 10 run = 80 panggilan per request. Apakah itu batas yang lo mau?

**Performa**
- `getProviderHealth` menjalankan 2 query per request. Index `idx_rd_ts` dipakai untuk sample. Cek `EXPLAIN QUERY PLAN` di DB lo kalau row sudah jutaan.
- `buildPayloadCatalog()` dipanggil tiap GET benchmark. Ada cache 60s di route payload-catalog, tapi route benchmark belum punya cache.

**Konsistensi**
- Logika liveness sekarang ada di **tiga tempat**: `/v1/models` (server), `combos/page.js` (client), `comboHeal.js` (server). Ketiganya harus setuju. Kalau salah satu diubah, dua lainnya ikut.

---

## Perintah verifikasi ulang

```bash
# test
cd tests && npx vitest run unit/combo-heal.test.js unit/payload-scorer.test.js \
  unit/payload-runner.test.js unit/token-estimate-family.test.js \
  unit/v1-models-combo-liveness.test.js unit/provider-health.test.js

# lint
npx eslint src/lib/comboHeal.js src/app/api/combos/heal/route.js \
  open-sse/payload/payloadScorer.js open-sse/payload/payloadRunner.js \
  src/app/api/developer/payload-benchmark/route.js

# build (butuh RAM >= 8GB)
npm run build

# git
git log --oneline 36ef6a9..HEAD
```
