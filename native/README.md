# 모픽 네이티브 셸 (Capacitor)

모픽 웹앱(`invest/`)을 iOS·Android 앱으로 패키징하는 Capacitor 프로젝트입니다.
앱스토어 입점 준비용으로 미리 구성해 둔 뼈대이며, 실제 iOS 빌드는 **Mac + Xcode** 가 필요합니다.

## 1. 처음 설정 (Mac에서 1회)

```bash
cd native
npm install
npm run sync-www          # invest/ → www/ 복사
npx cap add ios           # ios/ 폴더 생성 (Xcode 프로젝트)
npx cap add android       # android/ 폴더 생성 (Android Studio 프로젝트)
```

- iOS: Xcode 에서 `ios/App/App.xcworkspace` 를 열고 Signing & Capabilities 에서 팀을 지정합니다.
- 앱 ID(`kr.mopick.app`)는 `capacitor.config.json` 의 placeholder 입니다. Apple Developer 계정에
  등록할 실제 Bundle ID 로 바꾼 뒤 `npx cap sync` 를 다시 실행하세요.

## 2. 웹앱을 고친 뒤 반영

```bash
npm run ios       # sync-www + cap sync + Xcode 열기
npm run android   # sync-www + cap sync + Android Studio 열기
```

`sync-www.mjs` 는 `invest/` 를 그대로 `www/` 로 복사하고, `window.MOPICK_NATIVE = true`
플래그를 심습니다. 앱 코드에서 네이티브 셸 전용 분기(웹 푸시 안내 숨기기 등)에 쓸 수 있습니다.

## 3. 앱스토어 심사 전 남은 일 (중요한 순서)

| 항목 | 왜 필요한가 | 방법 |
|---|---|---|
| 인앱결제(IAP) | 가이드라인 3.1.1: 구독은 Apple IAP 의무. 현재 요금제 화면은 데모 결제라 그대로 내면 2.1 리젝 | RevenueCat(`@revenuecat/purchases-capacitor`) 권장. 네이티브에서는 IAP, 웹에서는 기존 결제(추후) |
| Sign in with Apple | 가이드라인 4.8: 카카오 로그인이 있으면 Apple 로그인 필수 | Supabase Auth 의 Apple provider 켜고 로그인 화면에 버튼 추가 |
| 네이티브 푸시(APNs) | 4.2(웹 래핑) 방어 + iOS 웹 푸시 제약 해소. 강력 추천 알림 로직은 이미 있음(`scripts/send-push-alerts.mjs`) | `@capacitor/push-notifications` + 발송 스크립트에 APNs 경로 추가 |
| 카카오 OAuth 리디렉트 | 네이티브 셸의 origin 은 `capacitor://localhost` 라 현재 redirectTo 가 안 맞음 | Supabase → Auth → URL Configuration 에 커스텀 스킴 추가, 앱은 `@capacitor/browser` 로 OAuth 열기 |
| 계정 삭제 | 가이드라인 5.1.1 | 완료: 내 계정 창 "회원 탈퇴" (supabase/schema.sql 의 `delete_my_account` 실행 필요) |
| 심사 제출물 | 심사 통과 실무 | Max 권한 데모 계정, 개인정보처리방침 URL, App Privacy 라벨, 스크린샷 |

투자 정보 유료 구독은 유사투자자문업 신고(2026-12 예정) 완료 후에 결제를 켜는 일정과 맞춥니다.

## 참고

- Android 는 Mac 없이도 가능: `npx cap add android` 후 Android Studio 에서 빌드.
  더 빠른 입점이 목표라면 PWA 를 그대로 올리는 TWA(Bubblewrap) 경로도 있습니다.
- `www/` 와 `node_modules/` 는 생성물이라 커밋하지 않습니다 (`.gitignore`).
  `ios/`, `android/` 폴더는 생성 후 커밋해서 설정(서명 제외)을 버전 관리하는 것을 권장합니다.
