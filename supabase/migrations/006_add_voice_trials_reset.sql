-- Add a date column to reset free TTS trials daily
alter table public.profiles
  add column if not exists voice_trials_reset_at date;


