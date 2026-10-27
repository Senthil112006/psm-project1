# PSM InternHub

## Start the local admin app

1. Install Node.js 18 or later.
2. Install dependencies with `npm install`.
3. Use the local `.env` file in this folder. If it is missing, create it from `.env.example` and set `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and `SESSION_SECRET`.
4. Start the app with `npm start`, then open `http://127.0.0.1:3000`.

Always open the app through the server. Opening `index.html` directly as a file bypasses the server-side login.

The administrator password is stored as a salted scrypt hash, not as source code. Generate a hash with:

```js
const crypto = require('node:crypto');
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('your-password', salt, 64).toString('hex');
console.log(`${salt}:${hash}`);
```

Set `ADMIN_PASSWORD_HASH` to the generated `salt:hash` value. Use a unique password for any real deployment.

Intern records are saved in the server-side `data/interns.json` dataset and shared by admin browsers using the same server. The browser keeps a local cache and automatically seeds the server dataset from existing browser records the first time the server dataset is initialized. Keep the data directory on persistent storage and include it in your backups.

Intern records support manually editable unique IDs, mentor names and IDs, mentor review and evaluation notes, and saved marks for each weighted grading category. The overall score and grade are calculated from the saved marks.

## Supabase Database Integration

InternHub supports **Supabase PostgreSQL** as the cloud database for persistent multi-device storage and verified public profile lookups.

### 1. Configure Credentials
In your local `.env` file (and in your cloud host environment variables):
```env
SUPABASE_URL=https://<your-project-id>.supabase.co
SUPABASE_KEY=<your-server-side-supabase-key>
```

### 2. Create Database Table
1. Open your project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor** -> **New query**.
3. Copy and run the SQL from `supabase-schema.sql` in this repository.

### 3. Sync Existing Student Cohort to Supabase
Run the sync command in terminal to migrate all student records:
```bash
npm run db:sync
```
When running, the server automatically uses Supabase for reading, updating, and public profile lookups, with local file caching as an offline fallback.

## Intern-specific profile QR codes

The Portfolio and ID card QR codes are generated as signed links to one intern's standalone public profile. The QR does not open the admin dashboard or provide access to the intern directory. Anyone with a profile link can view that profile, so share it only as appropriate. Older imported QR images are ignored; the app generates a specific profile QR instead.

For phone scanning or public access, deploy the app at a public HTTPS address. The default local server address only works on this computer.

## Deploy to Render

1. Push the project to a private GitHub repository. Do not commit `.env`; it is excluded by `.gitignore`.
2. In Render, create a **Blueprint** from that repository. Render reads `render.yaml` and creates the web service.
3. In the Render service environment settings, set `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. Generate a new, unique administrator password hash using the script above; do not use a password that has been shared in chat. Render generates `SESSION_SECRET`.
4. Deploy the service. The Blueprint provisions persistent storage at `/var/data`, where the intern dataset is stored. Use the HTTPS `onrender.com` URL shown in the Render dashboard to access the login page and generate intern QR links.

The admin site remains protected by the login; public QR links reveal only their signed intern profile. Each profile link is shareable by anyone who has it. Render persistent disks require a paid service and support one service instance; confirm the disk and service pricing in your Render account before deploying. The session store is in memory, so admin sessions are cleared on service restarts.


## Important deployment notes

- This is a **Node.js/Express application**, not a static GitHub Pages application. Deploy it as a Render Web Service using the included `render.yaml` Blueprint, or another Node.js host.
- Do not deploy `index.html` by itself to GitHub Pages: the server-side login, API routes, and persistent data storage will not run there.
- Keep the GitHub repository private if the JSON data files contain real student information. Do not commit `.env`, passwords, session secrets, or database service-role keys.
- The server no longer serves the `data/` directory publicly and no longer exposes a public endpoint that returns the entire intern directory. Individual public profile links are handled by the signed profile endpoint.
- In Render, set a unique `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. The password hash must be `salt:hash`, with a 32-character hexadecimal salt and a 128-character hexadecimal scrypt hash. Keep the password itself private.
- If using Supabase, use a server-side secret key only in the Render environment. Never place a service-role/secret key in HTML or browser JavaScript. Configure database access policies before enabling cloud database access.
