# 🚀 WhatsApp Automation API (Baileys + Supabase)

A production-ready, ultra-lightweight WhatsApp automation server built with **Node.js** and **Baileys**. Optimized for **Render Free Tier** and **n8n** integration.

## 🌟 Key Features
- **Zero-Config Database:** Automatically creates all necessary tables in Supabase on startup.
- **Pairing Code Connection:** Link your WhatsApp by entering a code on your phone—no QR scanning required.
- **Persistent Sessions:** Your login survives server restarts and redeploys (stored securely in Supabase).
- **Advanced Messaging:** Supports Text, Media (Images/Video), Reactions, and Replying to messages.
- **Status (Stories):** Post text or media updates to your WhatsApp Status.
- **Group Management:** Full support for group messaging and fetching group lists.
- **n8n Integration:** Built-in webhooks to push incoming messages and status updates to your workflows.

---

## 🛠 Prerequisites
1. **Supabase Project:** [Create a free account](https://supabase.com).
2. **Render Account:** [Create a free account](https://render.com).
3. **WhatsApp Number:** A number to use for automation (International format, e.g., `254712345678`).

---

## 🚀 One-Click Deployment Setup

### 1. Database Configuration (Supabase)
1. In your Supabase Dashboard, go to **Project Settings > Database**.
2. Under **Connection String**, select **Node.js**.
3. Copy the URI. It looks like:
   `postgres://postgres.[YOUR-ID]:[YOUR-PASSWORD]@aws-0-xx-pooler.supabase.com:6543/postgres`
4. **Important:** Ensure you replace `[YOUR-PASSWORD]` with your actual database password.

### 2. Deployment (Render)
1. Create a **New Web Service** on Render.
2. Connect this GitHub Repository.
3. Select **Docker** as the Runtime.
4. Add these **Environment Variables**:

| Key | Value | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgres://...` | Your Supabase Connection URI |
| `API_KEY` | `your_secret_password` | A password to protect your API endpoints |
| `N8N_WEBHOOK_URL` | `https://n8n.example.com/...` | (Optional) Your n8n Webhook URL |
| `PORT` | `3000` | Leave as 3000 |

---

## 📲 Connecting Your WhatsApp (Pairing)

No need to take photos of QR codes. Follow these steps:

1. Once the app is **Live** on Render, use a tool like Postman or a simple `curl` command to request a code:
   - **Endpoint:** `POST https://your-app-name.onrender.com/pair`
   - **Headers:** `x-api-key: your_secret_password`
   - **Body (JSON):** `{ "phoneNumber": "254712345678" }`
2. You will receive an 8-character code: `ABCD-1234`.
3. Open WhatsApp on your phone > **Settings** > **Linked Devices** > **Link a Device**.
4. Select **"Link with phone number instead"** at the bottom.
5. Enter the code. Your server is now authenticated!

---

## 📡 API Reference (For n8n / HTTP Requests)

All requests must include the header: `x-api-key: YOUR_SECRET_PASSWORD`.

### 1. Messaging
- **Send Text:** `POST /message/send`
  - Body: `{ "to": "254712345678", "message": "Hello!" }`
- **Send Media (Image/Video):** `POST /message/media`
  - Body: `{ "to": "254...", "type": "image", "url": "https://link.com/img.jpg", "caption": "Caption" }`
- **React to Message:** `POST /message/react`
  - Body: `{ "to": "254...", "messageId": "ID_HERE", "emoji": "👍" }`

### 2. Status Updates (Stories)
- **Post Text Status:** `POST /status/text`
  - Body: `{ "text": "New Deals!", "backgroundColor": "#FF5733" }`
- **Post Media Status:** `POST /status/media`
  - Body: `{ "url": "https://link.com/video.mp4", "type": "video", "caption": "Check this!" }`

### 3. Groups
- **Get Groups:** `GET /groups` (Returns list of all group names and IDs)
- **Send to Group:** `POST /message/send`
  - Body: `{ "to": "12345678@g.us", "message": "Hi Group!", "isGroup": true }`

---

## 🔄 Bi-Directional n8n Flow

1. **Inbound (WhatsApp → n8n):**
   - The server sends a POST to your `N8N_WEBHOOK_URL` for every new message or status update.
   - Example Payload: `{"from": "254...", "body": "How much?", "pushName": "John"}`

2. **Outbound (n8n → WhatsApp):**
   - Use the **HTTP Request** node in n8n.
   - Target your Render URL (e.g., `/message/send`).
   - n8n "talks back" to the customer automatically based on your workflow logic.

---

## 🛡 Security & Best Practices
- **Never Share API Keys:** Keep your `API_KEY` and `DATABASE_URL` private.
- **Avoid Spam:** Do not send more than 15-20 messages per minute.
- **Warm-up:** Start with a few messages per day and gradually increase to avoid WhatsApp bans.
- **Engagement:** Ensure people reply to your bot; if too many people block you, WhatsApp will flag the number.

---

**Developed By ADVAY254 for small businesses to automate like pros. 🚀**
