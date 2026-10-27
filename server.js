const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');
const express = require('express');
const rateLimit = require('express-rate-limit');
const session = require('express-session');

dotenv.config();

const {
  isSupabaseConfigured,
  fetchAllInternsFromSupabase,
  syncInternsToSupabase,
  fetchSingleInternFromSupabase
} = require('./supabaseClient');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME?.trim();
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH?.trim();
const SESSION_SECRET = process.env.SESSION_SECRET?.trim();
const passwordHashParts = ADMIN_PASSWORD_HASH?.split(':') ?? [];
const validPasswordHash = passwordHashParts.length === 2 &&
  /^[a-f0-9]{32}$/i.test(passwordHashParts[0]) &&
  /^[a-f0-9]{128}$/i.test(passwordHashParts[1]);

if (!ADMIN_USERNAME || !validPasswordHash || !SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('Configure ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and a 32-character SESSION_SECRET in .env.');
}

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const loginPage = path.join(__dirname, 'login.html');
const internHubPage = path.join(__dirname, 'index.html');
const dataDirectory = path.resolve(process.env.INTERNHUB_DATA_DIR || path.join(__dirname, 'data'));
const internsFile = path.join(dataDirectory, 'interns.json');
const seedInternsFile = path.join(__dirname, 'data', 'seed-interns.json');

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use('/api/interns', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '10kb' }));
app.use(['/assets', '/profile/assets'], express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));
// Security headers for same-origin deployment. Do not enable wildcard CORS:
// admin APIs rely on a session cookie and should not be callable cross-origin.
app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});
app.use(session({
  name: 'internhub.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 4 * 60 * 60 * 1000
  }
}));

function sendLoginPage(res, errorCode = '') {
  const errors = {
    invalid: ['Incorrect username or password.', 401],
    limited: ['Too many login attempts. Wait 15 minutes and try again.', 429]
  };
  const [message, status] = errors[errorCode] || ['', 200];
  fs.readFile(loginPage, 'utf8', (error, html) => {
    if (error) {
      console.error('Login page could not be read.', error);
      res.status(500).send('Login page is unavailable.');
      return;
    }
    const errorMarkup = message ? `<p class="error" role="alert">${message}</p>` : '';
    res.status(status).type('html').send(html.replace('<!--LOGIN_ERROR-->', errorMarkup));
  });
}

function isValidCredentials(username, password) {
  const usernameMatches = username === ADMIN_USERNAME;
  const [salt, encodedHash] = passwordHashParts;
  const suppliedHash = crypto.scryptSync(password, salt, 64);
  const expectedHash = Buffer.from(encodedHash, 'hex');
  const passwordMatches = crypto.timingSafeEqual(suppliedHash, expectedHash);
  return usernameMatches && passwordMatches;
}

function requireAdmin(req, res, next) {
  if (req.session.authenticated === true) {
    next();
    return;
  }
  res.redirect('/login');
}

function requireAdminApi(req, res, next) {
  if (req.session.authenticated === true) {
    next();
    return;
  }
  res.status(401).json({ error: 'Administrator login required.' });
}

function normalizeInternRecords(records) {
  if (!Array.isArray(records) || records.length > 5000) return null;
  const seenIds = new Set();
  const categories = ['technical', 'projectQuality', 'problemSolving', 'taskCompletion', 'communication', 'teamwork'];
  const normalized = [];

  for (const intern of records) {
    if (!intern || typeof intern !== 'object' || Array.isArray(intern)) return null;
    const text = (key, maximum, required = false) => {
      if (typeof intern[key] !== 'string') return required ? null : '';
      const value = intern[key].trim();
      return required && !value ? null : value.slice(0, maximum);
    };
    const id = text('id', 100, true);
    const name = text('name', 100, true);
    const college = text('college', 120, true);
    const domain = text('domain', 100, true);
    const role = text('role', 120, true);
    const days = Number(intern.days);
    const total = Number(intern.total);
    const score = Number(intern.score);
    if (!id || !name || !college || !domain || !role || seenIds.has(id)) return null;
    if (!Number.isInteger(days) || !Number.isInteger(total) || days < 0 || total < 1 || days > total) return null;
    if (!Number.isFinite(score) || score < 0 || score > 100) return null;

    const inputMarks = intern.marks && typeof intern.marks === 'object' ? intern.marks : {};
    const marks = {};
    for (const category of categories) {
      const mark = Number(inputMarks[category] ?? score);
      if (!Number.isFinite(mark) || mark < 0 || mark > 100) return null;
      marks[category] = mark;
    }
    const skills = Array.isArray(intern.skills) && intern.skills.length <= 100 &&
      intern.skills.every(skill => typeof skill === 'string' && skill.length <= 200)
      ? intern.skills.map(skill => skill.trim()).filter(Boolean)
      : null;
    const photo = text('photo', 1_500_000);
    const qrImage = text('qrImage', 1_500_000);
    const github = text('github', 250);
    if (skills === null || photo === null || qrImage === null || github === null) return null;
    if (typeof intern.photo === 'string' && intern.photo.length > 1_500_000) return null;
    if (typeof intern.qrImage === 'string' && intern.qrImage.length > 1_500_000) return null;
    if (typeof intern.github === 'string' && intern.github.length > 250) return null;
    if (photo && !/^https?:\/\//i.test(photo) && !/^data:image\/(?:jpeg|png|webp);base64,/i.test(photo)) return null;
    if (qrImage && !/^data:image\/(?:jpeg|png|webp);base64,/i.test(qrImage)) return null;

    seenIds.add(id);
    normalized.push({
      ...intern,
      id,
      name,
      college,
      domain,
      role,
      days,
      total,
      score,
      grade: text('grade', 2) || '',
      status: intern.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
      mentorName: text('mentorName', 100),
      mentorId: text('mentorId', 100),
      mentorReview: text('mentorReview', 2000),
      evaluation: text('evaluation', 2000),
      project: text('project', 160),
      description: text('description', 500),
      github: github || '',
      photo,
      qrImage,
      skills,
      marks
    });
  }
  return normalized;
}

async function readLocalInternDataset() {
  try {
    const raw = await fs.promises.readFile(internsFile, 'utf8');
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    let records = data ? normalizeInternRecords(data.students) : null;
    if (!records) {
      console.warn('[InternHub] Persisted dataset missing or invalid. Attempting recovery from seed...');
      try {
        const seedRaw = await fs.promises.readFile(seedInternsFile, 'utf8');
        const seedData = JSON.parse(seedRaw);
        records = normalizeInternRecords(seedData.students);
        if (records && records.length > 0) {
          await writeLocalInternDataset(records);
          console.log(`[InternHub] Successfully recovered dataset from seed with ${records.length} records.`);
        }
      } catch (recoveryErr) {
        console.warn('[InternHub] Recovery from seed failed:', recoveryErr.message);
      }
    }
    if (!records) throw new Error('The persisted intern dataset has an invalid format.');
    return records;
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        const seedRaw = await fs.promises.readFile(seedInternsFile, 'utf8');
        const seedData = JSON.parse(seedRaw);
        const seedRecords = normalizeInternRecords(seedData.students);
        if (seedRecords && seedRecords.length > 0) {
          await writeLocalInternDataset(seedRecords);
          console.log(`[InternHub] Auto-initialized dataset from seed with ${seedRecords.length} records.`);
          return seedRecords;
        }
      } catch (seedError) {
        if (seedError.code !== 'ENOENT') {
          console.warn('[InternHub] Could not load seed dataset:', seedError.message);
        }
      }
      return null;
    }
    throw error;
  }
}

let datasetWriteQueue = Promise.resolve();

function writeLocalInternDataset(records) {
  const save = async () => {
    await fs.promises.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${internsFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(temporaryFile, `${JSON.stringify({ version: 1, students: records }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await fs.promises.rename(temporaryFile, internsFile);
    } catch (error) {
      await fs.promises.rm(temporaryFile, { force: true }).catch(cleanupError => {
        console.error('Temporary dataset file could not be cleaned up.', cleanupError);
      });
      throw error;
    }
  };

  const result = datasetWriteQueue.then(save);
  datasetWriteQueue = result.catch(error => {
    console.error('Intern dataset could not be saved locally.', error);
  });
  return result;
}

async function readInternDataset() {
  // 1. If Supabase is configured, read from Supabase as primary database
  if (isSupabaseConfigured()) {
    try {
      const supabaseRecords = await fetchAllInternsFromSupabase();
      if (Array.isArray(supabaseRecords) && supabaseRecords.length > 0) {
        const normalized = normalizeInternRecords(supabaseRecords);
        if (normalized && normalized.length > 0) {
          // Asynchronously update local file as cache/backup
          writeLocalInternDataset(normalized).catch(() => {});
          return normalized;
        }
      } else if (Array.isArray(supabaseRecords) && supabaseRecords.length === 0) {
        // Supabase table is empty; auto-seed from local data
        console.log('[InternHub] Supabase table "interns" is empty. Auto-seeding existing records...');
        const localRecords = await readLocalInternDataset();
        if (localRecords && localRecords.length > 0) {
          await syncInternsToSupabase(localRecords).catch(e => {
            console.warn('[InternHub] Auto-seed to Supabase notice:', e.message);
          });
          return localRecords;
        }
      }
    } catch (supabaseError) {
      console.warn('[InternHub] Supabase read failed, falling back to local file:', supabaseError.message);
    }
  }

  // 2. Fall back to local file storage
  return await readLocalInternDataset();
}

async function writeInternDataset(records) {
  // Always persist locally first so data is never lost
  const localResult = await writeLocalInternDataset(records);

  // Sync with Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      await syncInternsToSupabase(records);
      console.log(`[InternHub] Successfully synchronized ${records.length} records to Supabase.`);
    } catch (supabaseError) {
      console.error('[InternHub] Supabase synchronization failed:', supabaseError.message);
    }
  }

  return localResult;
}

function createProfileToken(profile) {
  const payload = Buffer.from(JSON.stringify(profile)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function readProfileToken(token) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !/^[a-f0-9]{64}$/i.test(signature)) return null;

  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const profile = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' || typeof profile.name !== 'string') return null;
    return profile;
  } catch {
    return null;
  }
}

function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function normalizePublicProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const stringField = (key, limit) => typeof input[key] === 'string' ? input[key].trim().slice(0, limit) : '';
  const id = stringField('id', 100);
  const name = stringField('name', 100);
  const college = stringField('college', 120);
  const domain = stringField('domain', 100);
  const role = stringField('role', 120);
  const score = Number(input.score);

  if (!id || !name || !college || !domain || !role || !Number.isFinite(score) || score < 0 || score > 100) return null;

  const photo = stringField('photo', 1_500_000);
  let safePhoto = '';
  if (photo) {
    if (/^data:image\/(?:jpeg|png|webp);base64,/i.test(photo)) {
      safePhoto = photo;
    } else {
      try {
        if (['http:', 'https:'].includes(new URL(photo).protocol)) safePhoto = photo;
      } catch {
        safePhoto = '';
      }
    }
  }

  const qrImage = stringField('qrImage', 1_500_000);
  const safeQrImage = /^data:image\/(?:jpeg|png|webp);base64,/i.test(qrImage) ? qrImage : '';

  const skills = Array.isArray(input.skills)
    ? input.skills.filter(skill => typeof skill === 'string').slice(0, 20).map(skill => skill.trim().slice(0, 60)).filter(Boolean)
    : [];
  const roundedScore = Math.round(score * 10) / 10;
  const grade = roundedScore >= 90 ? 'A+' : roundedScore >= 80 ? 'A' : roundedScore >= 70 ? 'B' : roundedScore >= 60 ? 'C' : roundedScore >= 50 ? 'D' : 'E';

  const marksInput = input.marks && typeof input.marks === 'object' ? input.marks : {};
  const categories = ['technical', 'projectQuality', 'problemSolving', 'taskCompletion', 'communication', 'teamwork'];
  const marks = {};
  for (const cat of categories) {
    const mark = Number(marksInput[cat] ?? roundedScore);
    marks[cat] = Number.isFinite(mark) && mark >= 0 && mark <= 100 ? mark : roundedScore;
  }

  const days = Number.isInteger(Number(input.days)) && Number(input.days) >= 0 ? Number(input.days) : 0;
  const total = Number.isInteger(Number(input.total)) && Number(input.total) >= 1 ? Number(input.total) : 90;

  const rawGithub = stringField('github', 250);
  let safeGithub = '';
  if (rawGithub) {
    const cleanGithub = rawGithub.startsWith('http://') || rawGithub.startsWith('https://') 
      ? rawGithub 
      : `https://github.com/${rawGithub.replace(/^@/, '')}`;
    try {
      const parsed = new URL(cleanGithub);
      if (['http:', 'https:'].includes(parsed.protocol)) safeGithub = parsed.href;
    } catch {
      safeGithub = '';
    }
  }

  return {
    id,
    name,
    college,
    domain,
    role,
    days,
    total,
    score: roundedScore,
    grade,
    status: input.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
    mentorName: stringField('mentorName', 100),
    mentorId: stringField('mentorId', 100),
    mentorReview: stringField('mentorReview', 2000),
    evaluation: stringField('evaluation', 2000),
    project: stringField('project', 160),
    description: stringField('description', 500),
    github: safeGithub,
    skills,
    marks,
    photo: safePhoto,
    qrImage: safeQrImage
  };
}

async function findPublicProfile(identifier) {
  if (typeof identifier !== 'string') return null;
  const decoded = decodeURIComponent(identifier).trim();
  if (!decoded) return null;

  // 1. Try finding directly from Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const intern = await fetchSingleInternFromSupabase(decoded);
      if (intern) {
        return normalizePublicProfile(intern);
      }
    } catch (err) {
      console.warn('[InternHub] Supabase profile lookup notice:', err.message);
    }
  }

  // 2. Try finding by student ID in dataset
  try {
    const dataset = await readInternDataset();
    if (Array.isArray(dataset)) {
      const intern = dataset.find(item => item.id.toLowerCase() === decoded.toLowerCase());
      if (intern) {
        return normalizePublicProfile(intern);
      }
    }
  } catch (error) {
    console.error('Could not query dataset for public profile.', error);
  }

  // 2. Fall back to signed profile token
  const tokenProfile = readProfileToken(decoded);
  if (tokenProfile) {
    return normalizePublicProfile(tokenProfile);
  }

  return null;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => sendLoginPage(res, 'limited')
});

app.get('/login', (req, res) => {
  if (req.session.authenticated === true) {
    res.redirect('/');
    return;
  }
  sendLoginPage(res);
});

app.post('/login', loginLimiter, (req, res, next) => {
  const username = typeof req.body.username === 'string' ? req.body.username : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (username.length > 254 || password.length > 256 || !isValidCredentials(username, password)) {
    sendLoginPage(res, 'invalid');
    return;
  }

  req.session.regenerate(error => {
    if (error) {
      next(error);
      return;
    }
    req.session.authenticated = true;
    req.session.save(saveError => {
      if (saveError) {
        next(saveError);
        return;
      }
      res.redirect('/');
    });
  });
});

app.post('/logout', requireAdmin, (req, res, next) => {
  req.session.destroy(error => {
    if (error) {
      next(error);
      return;
    }
    res.clearCookie('internhub.sid', { httpOnly: true, sameSite: 'strict' });
    res.redirect('/login');
  });
});

app.get('/api/interns', requireAdminApi, async (_req, res, next) => {
  try {
    res.json({ students: await readInternDataset() });
  } catch (error) {
    next(error);
  }
});

app.put('/api/interns', requireAdminApi, async (req, res, next) => {
  const records = normalizeInternRecords(req.body?.students);
  if (!records) {
    res.status(400).json({ error: 'The intern dataset is invalid or contains duplicate IDs.' });
    return;
  }
  try {
    await writeInternDataset(records);
    res.json({ saved: true, students: records });
  } catch (error) {
    next(error);
  }
});

app.get('/api/network-info', (_req, res) => {
  const localIp = getLocalNetworkIp();
  res.json({
    localIp,
    port,
    baseUrl: process.env.PUBLIC_BASE_URL || `http://${localIp}:${port}`
  });
});

app.post('/api/profile-link', requireAdmin, (req, res) => {
  const profile = normalizePublicProfile(req.body);
  if (!profile) {
    res.status(400).json({ error: 'A valid intern profile is required to generate its QR link.' });
    return;
  }
  const token = createProfileToken(profile);
  res.json({
    path: `/profile/${encodeURIComponent(profile.id)}`,
    tokenPath: `/profile/${token}`,
    id: profile.id
  });
});

app.get(['/profile', '/profile/'], (_req, res) => res.redirect('/'));

app.get('/profile/:identifier', async (req, res) => {
  const profile = await findPublicProfile(req.params.identifier);
  if (!profile) {
    res.status(404).send('This intern profile link is invalid or unavailable.');
    return;
  }
  res.sendFile(path.join(__dirname, 'profile.html'));
});

app.get('/api/public-profile/:identifier', async (req, res) => {
  const profile = await findPublicProfile(req.params.identifier);
  if (!profile) {
    res.status(404).json({ error: 'This intern profile link is invalid or unavailable.' });
    return;
  }
  res.json(profile);
});

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/', requireAdmin, (_req, res) => res.sendFile(internHubPage));
app.get('/index.html', requireAdmin, (_req, res) => res.sendFile(internHubPage));
app.use((_req, res) => res.status(404).send('Not found.'));

app.use((error, _req, res, _next) => {
  console.error('InternHub request failed.', error);
  if (res.headersSent) return;
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  res.status(status).send(status === 413 ? 'Request body is too large.' : status === 400 ? 'The request is invalid.' : 'An unexpected server error occurred.');
});

app.listen(port, host, async () => {
  console.log(`InternHub is listening on ${host}:${port}`);
  if (isSupabaseConfigured()) {
    console.log('[InternHub] Supabase Database Mode: ACTIVE');
  } else {
    console.log('[InternHub] Local Storage Mode (configure SUPABASE_URL in .env to connect Supabase)');
  }
  try {
    const records = await readInternDataset();
    if (records) {
      console.log(`[InternHub] Connected to backend dataset (${records.length} records loaded).`);
    } else {
      console.log('[InternHub] Backend dataset ready (empty or awaiting records).');
    }
  } catch (err) {
    console.error('[InternHub] Failed to initialize backend dataset:', err.message);
  }
});
