-- Add voice credits system for top-up purchases
alter table public.profiles
  add column if not exists voice_credits integer not null default 0;

-- Add index for efficient voice credit queries
create index if not exists idx_profiles_voice_credits on public.profiles(voice_credits);

-- Update existing users to have base voice credits based on their plan
update public.profiles 
set voice_credits = case 
  when plan_tier = 'free' then 10
  when plan_tier = 'basic' then 50
  when plan_tier = 'premium' then 500
  else 10
end
where voice_credits = 0;
