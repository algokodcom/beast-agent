# 🚀 Beast Agent — Dağıtım Kılavuzu (Release Guide)

> Bu dosya sürüm çıkaran kişi içindir. Son kullanıcı için bkz: [README.md](README.md)

## ⚡ Tek Komutla Dağıtım

```bash
npm run release -- patch     # 0.15.0 → 0.15.1 (hata düzeltmeleri)
npm run release -- minor     # 0.15.0 → 0.16.0 (yeni özellikler)  ← normalde bu
npm run release -- major     # 0.15.0 → 1.0.0   (büyük değişiklik)
npm run release -- 0.17.0    # belirli sürüm numarası
```

Script: `scripts/release.js` — 6 adımı sırayla ve otomatik yapar:

| # | Adım | Ne yapar |
|---|------|----------|
| 1 | Sürüm bump | `package.json` sürümünü yükseltir |
| 2 | Git sync | commit + `v< sürüm >` tag + GitHub'a push |
| 3 | Build | `npm run dist` → Setup + Portable exe derler |
| 4 | GitHub Release | exe + blockmap + latest.yml'yi upload eder |
| 5 | npm publish | `beast-agent` paketini npm'e basar (token ister) |
| 6 | OneDrive yedek | `beast-v< sürüm >` klasörüne kaynak kopyası + bilgi dosyası |

## 🔧 Dağıtım Öncesi Kontrol Listesi

1. **Çalışan Beast'i kapat** (tepsiden çık ya da süreçleri kapat) — yoksa build DLL kilidi alır
2. **GitHub giriş** (tek seferlik): `gh auth login` → durum: `gh auth status`
3. **npm token**: [npmjs.com → Access Tokens](https://www.npmjs.com/settings/~/tokens) → *Granular Token* üret (beast-agent paketine publish yetkisi), sonra:
   ```cmd
   set NPM_TOKEN=npm_xxxxxxxx
   ```
   (Token'u `set` ile oturum değişkeni olarak ver — dosyaya yazma, sohbete/messaja yapıştırma!)
4. Testler: `npm test` → hepsi geçmeli
5. `config.yaml` ve `.env` dosyalarının **git'te olmadığından** emin ol (`.gitignore` hallediyor)

## 🔄 Dağıtım Sonrası Otomatik Olanlar

- **GitHub Releases** sayfasında yeni exe'ler görünür → site (beast.algokod.com) linkleri sabit `releases/download/v< sürüm >/...` ise elle güncellenir
- **Kurulu kullanıcılar** (installer ile): açılışta + 6 saatte bir otomatik kontrol → otomatik indir → kapanışta otomatik kur
- **WhatsApp kullanıcıları**: `/update` yazarak da tetikleyebilir, `/update now` ile anında kurar
- **npm kullanıcıları**: `npm update -g beast-agent`
- Update zinciri electron-updater + `latest.yml` üzerinden çalışır — **latest.yml'yi release'e koymayı unutma** (script otomatik koyar)

## 🧯 Manuel Fallback (script takılırsa)

Her adımı elle de yapabilirsin:

```bash
# 1) sürümü elle yaz (package.json → "version")
# 2) git
git add -A && git commit -m "v0.16.0" && git tag v0.16.0 && git push origin main --tags
# 3) build
npm run dist
# 4) GitHub release
gh release create v0.16.0 "dist/BeastAgent-Setup-0.16.0.exe" "dist/BeastAgent-Setup-0.16.0.exe.blockmap" "dist/BeastAgent.exe" "dist/latest.yml" --title "Beast Agent v0.16.0" --notes "..."
# 5) npm (electron'u dependencies'e taşımak gerek!)
node scripts/swap-electron.js deps
npm publish
node scripts/swap-electron.js devdeps
# 6) OneDrive yedeği
robocopy . "..\..\OneDrive\Masaüstü\Beast Agent\beast-v0.16.0" /E /XD node_modules dist .git
```

## ⚠️ Bilinen Tuzaklar

- **electron-builder**, `electron` paketinin devDependencies'te olmasını ister; **npm -g kurulumu** ise dependencies'te olmasını ister. Çözüm: publish anında `scripts/swap-electron.js` otomatik taşır (prepublishOnly/postpublish hook'ları). Elle dağıtımda 5. adımdaki swap'i atlama!
- Build sırasında **"EPERM ... sharp ... dll"** hatası alırsan Beast çalışıyor demektir → kapat, tekrar `npm run dist`
- Portable exe'de (BeastAgent.exe) updater çalışmaz (npm/taşınabilir mod) — sadece installer kurulumunda otomatik güncelleme vardır
- `latest.yml` eski sürümü işaret ediyorsa kullanıcılar yanlış sürüm görür — her release'te yenisi ile değişir (script halleder)

## 📦 Sürüm Numarası Kuralları (semver)

- **patch** (0.15.0 → 0.15.1): hata düzeltmeleri
- **minor** (0.15.0 → 0.16.0): yeni özellik, yeni sekme/komut
- **major** (1.0.0): kırıcı değişiklik / mimari sıçrama
