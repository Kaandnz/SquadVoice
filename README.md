# SquadVoice

10 kişiye kadar arkadaş grubunla kullanabileceğin **%100 ücretsiz**, çok düşük gecikmeli, Discord benzeri sesli sohbet, oyun/ekran paylaşımı ve yazılı sohbet uygulaması.

## Öne Çıkan Özellikler
- **%100 Ücretsiz 7/24 Firebase Altyapısı (Önerilen):** **Firebase Hosting + Authentication + Realtime Database** (Spark Planı — kredi kartı gerekmez). Ses ve ekran yayını sunucudan geçmeden doğrudan arkadaşlar arasında **P2P WebRTC** ile akar.
- **Alternatif Kendi Sunucun (`server/`):** İstersen kendi PC'nde veya VPS'te çalışabilen `Rust (Axum + Tokio + SQLite)` sunucusu da dahildir.
- **Ses Kalitesi:** Opus **64 / 96 / 128 kbps**, isteğe bağlı **Stereo**, AEC / Gürültü Azaltma / AGC, kişi bazlı **%0–%200 ses yükseltme**, konuşan göstergesi, **Bas-Konuş (Push-to-Talk)** (Tauri masaüstünde oyun içindeyken global çalışır).
- **Ekran & Oyun Yayını:** 720p30 / 1080p30 / 1080p60 presetleri, Oyun (FPS öncelikli) veya Kod/Metin (keskinlik) modu, sistem sesi paylaşımı ve canlı ping / FPS / çözünürlük / bitrate göstergesi.
- **Tüm Platformlar:** Windows (`.exe`/`.msi`), macOS (`.dmg`/`.app`), Android (`.apk` / PWA) ve iOS (Safari PWA ile \$0).

---

## 1. %100 Ücretsiz 7/24 Firebase Kurulumu (Kredi Kartı Yok)

### Gereksinimler
- Ücretsiz Google / Firebase hesabı
- Node.js 20+

### Adım 1: Firebase CLI ile giriş yap ve projeyi bağla
```bash
npx -y firebase-tools@latest login
npx -y firebase-tools@latest projects:create squadvoice-ekip --display-name "SquadVoice"
npx -y firebase-tools@latest use squadvoice-ekip
```
*(Mevcut bir projen varsa sadece `npx -y firebase-tools@latest use PROJE_ID` çalıştır.)*

### Adım 2: Firebase Console'dan 2 servisi aktif et
1. **Authentication → Sign-in method:** `Email/Password` aktif et (veya `npx -y firebase-tools@latest deploy --only auth`).
2. **Realtime Database → Create Database:** Bölge olarak **Belgium (`europe-west1`)** seç ve **Locked mode** ile oluştur.
3. **Project Settings → Your apps → Web (`</>`)** ekle, verilen `firebaseConfig` bilgilerini `client/.env` dosyasına yaz (`client/.env.example` dosyasını kopyala).

### Adım 3: Güvenlik kurallarını ve uygulamayı yayınla
```bash
cd client && npm install && npm run build && cd ..
npx -y firebase-tools@latest deploy --only database,hosting
```
Canlı adresin hazır: `https://PROJE_ID.web.app`!
- İlk kayıt olan kişi otomatik **admin** olur ve girdiği davet kodunu (varsayılan `SQUAD-2026`) ekibin şifresi olarak belirler.
- Güvenlik kuralları (`database.rules.json`) **oda başı en fazla 10 kullanıcı** ve **davet kodu/linki** kontrolünü sunucu tarafında zorunlu kılar.

### Adım 4: Otomatik Yayınlama (GitHub Actions → Firebase CI/CD)
Projede hazır [`.github/workflows/deploy-firebase.yml`](.github/workflows/deploy-firebase.yml) pipeline'ı bulunur. `main` dalına her push yaptığında testleri çalıştırır, istemciyi derler ve Firebase Hosting + Realtime Database kurallarını otomatik olarak canlıya alır.

Kurmak için GitHub repo → **Settings → Secrets and variables → Actions** altına şunları ekle:
1. `FIREBASE_SERVICE_ACCOUNT`: Google Cloud Console → **IAM & Admin → Service Accounts** üzerinden **Firebase Admin** rolüyle oluşturduğun Service Account'un JSON anahtar içeriği.
2. `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID` *(yerel `client/.env` içindeki değerler)*.
3. *(Opsiyonel)* `VITE_DEFAULT_INVITE_CODE` ve `VITE_TURN_WORKER_URL`.

---

## 2. Masaüstü Uygulamalarını Çıkarma (Windows `.exe` & macOS `.dmg`)

`client/.env` içinde Firebase bilgilerin varken derlediğinde masaüstü uygulamaları doğrudan senin Firebase projenle konuşur:

- **macOS (`.dmg` / `.app`) — Kendi Mac'inde:**
  ```bash
  cd client
  npm run tauri build
  ```
- **Windows (`.exe` / `.msi`) & macOS Universal (`.dmg`) — Otomatik GitHub Actions:**
  [`.github/workflows/build-desktop.yml`](.github/workflows/build-desktop.yml) dosyası `main` dalına `client/` güncellemesi geldiğinde otomatik çalışır; hem Windows `.exe`/`.msi` hem macOS Universal `.dmg` (Apple Silicon + Intel) paketlerini derleyip GitHub Releases (`latest`) altına otomatik yayınlar. Web uygulamasındaki **PC Uygulamasını İndir** penceresi bu dosyaları otomatik çeker.

---

## 3. Telefonlara Kurulum (iPhone & Android)
- **iPhone / iPad (iOS — \$0):** Safari'den `https://PROJE_ID.web.app` aç → **Paylaş → Ana Ekrana Ekle**. Tam ekran, bağımsız uygulama gibi çalışır.
- **Android:** Chrome'dan **Ana Ekrana Ekle** yapabilir veya `cd client && npx tauri android init && npx tauri android build --apk` ile ücretsiz `.apk` üretebilirsin.

---

## 4. Alternatif: Rust Sunucusu ile Yerel/VPS Çalıştırma
Firebase yerine kendi makineni kullanmak istersen `client/.env` olmadan derlemen yeterli:
```bash
cd server && cp .env.example .env && cargo run --release
```
Dışarıya açmak için `cloudflared tunnel --url http://localhost:3001` veya `docker compose up -d` kullanabilirsin.
