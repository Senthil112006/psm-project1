const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const {
  isSupabaseConfigured,
  syncInternsToSupabase,
  fetchAllInternsFromSupabase
} = require('../supabaseClient');

async function main() {
  console.log('========================================================');
  console.log('  PSM InternHub -> Supabase Database Migration & Sync   ');
  console.log('========================================================\n');

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = (
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY
  )?.trim();

  if (!supabaseUrl || supabaseUrl.includes('your-project-ref')) {
    console.error('❌ ERROR: SUPABASE_URL is missing or still set to placeholder in your .env file!');
    console.error('👉 Please open .env and set:');
    console.error('   SUPABASE_URL=https://<your-project-id>.supabase.co\n');
    console.error('You can find your Project URL in the Supabase Dashboard:');
    console.error('Project Settings -> API -> Project URL\n');
    process.exit(1);
  }

  if (!supabaseKey) {
    console.error('❌ ERROR: SUPABASE_KEY is missing in your .env file!\n');
    process.exit(1);
  }

  if (!isSupabaseConfigured()) {
    console.error('❌ ERROR: Could not connect to Supabase with the current configuration.');
    console.error(`URL: ${supabaseUrl}`);
    process.exit(1);
  }

  console.log(`📡 Connecting to Supabase project at: ${supabaseUrl}`);

  // 1. Read existing local records from data/interns.json or seed-interns.json
  const dataDir = path.resolve(process.env.INTERNHUB_DATA_DIR || path.join(__dirname, '..', 'data'));
  const internsFile = path.join(dataDir, 'interns.json');
  const seedFile = path.join(__dirname, '..', 'data', 'seed-interns.json');

  let fileToRead = internsFile;
  if (!fs.existsSync(fileToRead)) {
    fileToRead = seedFile;
  }

  if (!fs.existsSync(fileToRead)) {
    console.error('❌ ERROR: No local student data found to sync in data/ directory.');
    process.exit(1);
  }

  console.log(`📂 Reading local records from: ${path.basename(fileToRead)}...`);
  const rawData = fs.readFileSync(fileToRead, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch (err) {
    console.error('❌ ERROR: Invalid JSON in local dataset file:', err.message);
    process.exit(1);
  }

  const students = Array.isArray(parsed) ? parsed : parsed.students;
  if (!Array.isArray(students) || students.length === 0) {
    console.error('❌ ERROR: No student records found in file.');
    process.exit(1);
  }

  console.log(`📋 Found ${students.length} student records to sync.`);

  // 2. Upload records to Supabase
  try {
    console.log('🚀 Uploading student cohort to Supabase table "interns"...');
    const result = await syncInternsToSupabase(students);
    console.log(`\n✅ SUCCESS! ${result.count} student records synced to Supabase:`);
    students.forEach((s, idx) => {
      console.log(`   ${idx + 1}. [${s.id}] ${s.name} (${s.domain}) - Score: ${s.score}%`);
    });

    // 3. Verify by reading back from Supabase
    console.log('\n🔍 Verifying records from Supabase...');
    const liveRecords = await fetchAllInternsFromSupabase();
    console.log(`✅ Verified: Supabase table "interns" now contains ${liveRecords.length} live records.\n`);
    console.log('🎉 Your Supabase database is fully connected and ready for production!');
  } catch (syncErr) {
    console.error('\n❌ ERROR during Supabase synchronization:', syncErr.message);
    if (syncErr.message.includes('relation "interns" does not exist') || syncErr.message.includes('42P01')) {
      console.error('\n💡 HINT: The table "interns" has not been created in Supabase yet.');
      console.error('   Please run supabase-schema.sql in your Supabase SQL Editor.');
    } else if (syncErr.message.includes('row-level security') || syncErr.message.includes('RLS')) {
      console.error('\n💡 HINT: Row-Level Security (RLS) is currently blocking inserts on table "interns".');
      console.error('   Run this single command in your Supabase SQL Editor:');
      console.error('   ALTER TABLE public.interns DISABLE ROW LEVEL SECURITY;\n');
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected failure:', err);
  process.exit(1);
});
