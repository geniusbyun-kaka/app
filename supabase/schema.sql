-- 버픽 회원 정보 테이블
-- Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- 회원은 자기 정보만 읽을 수 있고, 바꿀 수 있는 건 닉네임(display_name)과 마지막 접속 시각뿐입니다.
-- 구독 등급(plan)과 관리자 여부(is_admin)는 대시보드(Table Editor)에서 관리자만 바꿀 수 있습니다.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  plan text not null default 'free' check (plan in ('free', 'pro', 'max')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- 열 단위 권한: 로그인한 회원도 plan, is_admin 은 못 바꿈
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, last_seen_at) on public.profiles to authenticated;

-- 가입하면 profiles 에 한 줄 자동 생성
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 이 SQL 을 실행하기 전에 이미 가입한 회원이 있으면 채워 넣기
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- 나를 관리자로 지정하려면: 먼저 앱에서 한 번 로그인한 뒤, 이메일을 바꿔서 아래 한 줄만 실행
-- update public.profiles set is_admin = true, plan = 'max' where email = '내이메일@example.com';
