# SquadVoice Cloudflare TURN Worker (1.000 GB/ay Ücretsiz)

Bu küçük Cloudflare Worker, yalnızca SquadVoice üyelerine (Firebase Auth + RTDB doğrulamasıyla) 24 saatlik geçici Cloudflare Realtime TURN bağlantı bilgisi üretir; API anahtarların asla istemci tarafına sızmaz.

## Kurulum (2 Dakika)
1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Calls / Realtime → TURN** menüsünden ücretsiz bir **TURN App** oluştur, **TURN Token ID** ve **API Token** değerlerini kopyala.
2. Bu klasörde giriş yapıp gizli anahtarları tanımla ve yayınla:
   ```bash
   cd cloudflare-turn-worker
   npx -y wrangler@latest login
   npx -y wrangler@latest secret put CF_TURN_KEY_ID
   npx -y wrangler@latest secret put CF_TURN_API_TOKEN
   npx -y wrangler@latest secret put FIREBASE_WEB_API_KEY
   npx -y wrangler@latest deploy
   ```
3. Çıkan `https://squadvoice-turn.<hesabin>.workers.dev/turn` adresini SquadVoice içindeki **Admin Paneli → Mobil Ses (TURN)** alanına yapıştır.
