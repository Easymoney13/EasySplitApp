# 🚀 EasySplit: Free Hosting, 24/7 Uptime & Custom Domain Guide

This guide covers the exact step-by-step process to host **EasySplit** for **$0/month** with **24/7 uptime (no 15-minute shutdowns)** and connect your custom domain via **Cloudflare**.

---

## 🏗️ Architecture Overview

```
[ User visits https://www.yourdomain.com ]
                      │
                      ▼
            [ Cloudflare DNS ] (At-cost domain ~$9/yr + Free SSL)
                      │
                      ▼
         [ Render Free Web Service ] (Node.js + WebSockets + Next.js)
                      ▲
                      │ (Pings every 5-10 min)
            [ UptimeRobot (Free) ] (Prevents 15-min spin down)
```

* **Hosting**: Render Free Tier ($0/mo)
* **Keep-Alive Bot**: UptimeRobot Free Tier ($0/mo)
* **Domain & DNS**: Cloudflare Registrar (~$9.77/year wholesale for `.com`)
* **SSL / Security**: Automatic Free HTTPS / TLS 🔒

---

## 📋 Step 1: Buy Your Domain on Cloudflare

1. Go to **[Cloudflare Registrar](https://www.cloudflare.com/products/registrar/)** (or login to your Cloudflare Dashboard and click **Domain Registration** → **Register Domains**).
2. Search for your desired domain name (e.g. `easysplit.com`, `easysplit.app`, `easysplitapp.com`).
3. Complete the checkout:
   * Cloudflare sells domains at wholesale cost with **zero markup** (~$9.77/yr for `.com`).
   * **WHOIS Privacy Protection** is included free forever.

---

## 📋 Step 2: Add Custom Domain to Render

1. Open your **[Render Dashboard](https://dashboard.render.com/)**.
2. Click on your web service: **`billspltapp`**.
3. In the left navigation menu, click **Settings**.
4. Scroll down to the **Custom Domains** section.
5. Click **"Add Custom Domain"**.
6. Enter both variations of your domain:
   * Root domain: `yourdomain.com`
   * Subdomain: `www.yourdomain.com`
7. Click **Save**.
8. Render will display the required DNS records (for example):
   * **CNAME** for `www` pointing to `billspltapp.onrender.com`
   * **A Record** (IP address like `216.24.57.1`) or **ANAME/ALIAS** for the root domain `@`

---

## 📋 Step 3: Configure Cloudflare DNS

1. Go to your **[Cloudflare Dashboard](https://dash.cloudflare.com/)** and click on your domain.
2. In the left sidebar, go to **DNS** → **Records**.
3. Add the records provided by Render:

### Record 1: The `www` Subdomain (Recommended)
* **Type**: `CNAME`
* **Name**: `www`
* **Target**: `billspltapp.onrender.com`
* **Proxy Status**: `DNS Only` (Grey Cloud) during initial verification, or `Proxied` (Orange Cloud)
* **TTL**: `Auto`
* Click **Save**.

### Record 2: The Root Domain (`@`)
* **Type**: `A` (or `CNAME` if using Cloudflare CNAME flattening)
* **Name**: `@` (or `yourdomain.com`)
* **Target / IPv4 address**: The IP address shown in Render (e.g. `216.24.57.1`) or `billspltapp.onrender.com`
* **Proxy Status**: `DNS Only` (Grey Cloud) during initial verification
* **TTL**: `Auto`
* Click **Save**.

---

## 📋 Step 4: Verify & Enable SSL

1. Return to your **Render Dashboard** → **Settings** → **Custom Domains**.
2. Click **"Verify"** next to your domain names.
3. Once DNS propagation completes (usually 1–5 minutes on Cloudflare), Render will show:
   * ✅ **DNS: Verified**
   * ✅ **Certificate: Active** (Free Let's Encrypt SSL provisioned)
4. Your website is now securely accessible via `https://www.yourdomain.com` and `https://yourdomain.com`.

---

## 📋 Step 5: Keep Server Awake 24/7 (UptimeRobot)

To ensure your Render instance **never spins down or goes to sleep**:

1. Log in to **[UptimeRobot](https://dashboard.uptimerobot.com/)**.
2. Check your active monitor:
   * **URL**: `https://billspltapp.onrender.com/` (or your new custom domain `https://www.yourdomain.com`)
   * **Monitoring Interval**: `5 minutes` or `10 minutes`
   * **Status**: `Up` (Green)
3. UptimeRobot will ping the application every 5–10 minutes 24/7, keeping the container warm with zero cold starts.

---

## 💡 Best Practices & Tips

1. **One Free Service Rule**: Render's free tier provides 750 hours/month per account (enough for one service running 24/7). Keep `billspltapp` as the only active free service on that Render account.
2. **WebSockets Compatibility**: WebSockets (`ws`) and real-time live table splitting work smoothly over both direct Render URLs and Cloudflare-proxied custom domains.
3. **Receipt OCR (Gemini)**: Ensure your `GEMINI_API_KEY` is configured in Render Environment Variables so camera receipt scanning is fully enabled.
4. **Instant Payment Deep Links**: Israeli banking deep links (Bit and PayBox) are embedded in the client response and work natively on mobile browsers.
