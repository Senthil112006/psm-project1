const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const newPassword = process.argv[2];

if (!newPassword) {
  console.log(`
Usage:
  node scripts/set-admin-password.js <your-new-password>

Example:
  node scripts/set-admin-password.js MySecretPass123!
`);
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
const passwordHash = `${salt}:${hash}`;
const sessionSecret = crypto.randomBytes(32).toString('hex');

const envPath = path.join(__dirname, '..', '.env');

if (!fs.existsSync(envPath)) {
  console.error('❌ .env file not found at:', envPath);
  process.exit(1);
}

let envContent = fs.readFileSync(envPath, 'utf8');

if (/^ADMIN_PASSWORD_HASH=/m.test(envContent)) {
  envContent = envContent.replace(/^ADMIN_PASSWORD_HASH=.*/m, `ADMIN_PASSWORD_HASH=${passwordHash}`);
} else {
  envContent += `\nADMIN_PASSWORD_HASH=${passwordHash}`;
}

if (!/^SESSION_SECRET=/m.test(envContent) || /SESSION_SECRET=replace-with.*/m.test(envContent)) {
  envContent = envContent.replace(/^SESSION_SECRET=.*/m, `SESSION_SECRET=${sessionSecret}`);
}

fs.writeFileSync(envPath, envContent, 'utf8');

console.log('✅ Admin password updated successfully!');
console.log('🔑 Salt:Hash: ' + passwordHash);
console.log('🚀 You can now start the server with: npm run dev');
