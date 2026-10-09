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

-- ── 마이 페이지: 관심 종목·관심 대가 (기기 간 동기화) ──────────────────────
-- My Page 의 별표(관심 종목 티커·관심 대가)를 계정에 저장해 PC·모바일 어디서 로그인해도
-- 같은 목록이 보입니다. 이 두 줄만 따로 실행해도 되고, 파일 전체를 다시 실행해도 안전합니다.
alter table public.profiles add column if not exists favorites jsonb;
grant update (favorites) on public.profiles to authenticated;

-- ── 강력 추천 매일 푸시 알림 구독 ──────────────────────────────────
-- 브라우저(기기)별 웹 푸시 구독 정보. 앱의 "매수 가격 따라가기 → 강력 추천 매일 알림"에서
-- 알림을 켜면 한 줄 생기고, push-alerts 워크플로가 service_role 키로 전체 목록을 읽어 발송합니다.
-- 회원은 자기 구독만 보고 지울 수 있습니다.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "read own push subscriptions" on public.push_subscriptions;
create policy "read own push subscriptions" on public.push_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "insert own push subscriptions" on public.push_subscriptions;
create policy "insert own push subscriptions" on public.push_subscriptions
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "delete own push subscriptions" on public.push_subscriptions;
create policy "delete own push subscriptions" on public.push_subscriptions
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;
