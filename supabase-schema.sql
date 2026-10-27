-- ============================================================
-- PSM InternHub - Supabase PostgreSQL Database Schema
-- Run this single query in Supabase SQL Editor:
-- ============================================================

CREATE TABLE IF NOT EXISTS public.interns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  college TEXT NOT NULL,
  domain TEXT NOT NULL,
  role TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 90,
  score NUMERIC(5, 2) NOT NULL DEFAULT 0,
  grade TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  "mentorName" TEXT DEFAULT '',
  "mentorId" TEXT DEFAULT '',
  "mentorReview" TEXT DEFAULT '',
  evaluation TEXT DEFAULT '',
  project TEXT DEFAULT '',
  description TEXT DEFAULT '',
  github TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  "qrImage" TEXT DEFAULT '',
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  marks JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);
