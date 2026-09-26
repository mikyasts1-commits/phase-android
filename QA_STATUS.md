# Phase Android — QA status (2026-09-25)

## Built
- `~/workspace/your_files/Phase-debug.apk` (5.8 MB, com.phase.app, v1.0, minSdk 24)
- Built offline against local Maven repo `~/maven-local` (330+ artifacts)
- Toolchain: JDK 21 (`~/jdk/jdk-21.0.12.1+1`), build-tools 35.0.0, AGP 8.13.0
- Build fixes applied in `android/app/build.gradle`: packaging excludes for Kotlin
  metadata (`commonMain/**`, `nativeMain/**`, `META-INF/kotlin-project-structure-metadata.json`),
  global exclude of stale `kotlin-stdlib-jdk8/jdk7`.

## Not done: mobile visual QA
- Local Playwright QA blocked: `cdn.playwright.dev` returns GatewayExceptionResponse
  through this environment's proxy/filter, so no Chromium binary can be installed.
  `~/.cache/ms-playwright/` is effectively empty.
- The delegated live-browser QA also failed (its Chromium VM is network-isolated
  from this VM, can't reach 127.0.0.1:8080).
- If retrying later: check whether the CDN is reachable, or have Mikyas report
  layout issues from the installed APK (best QA anyway).
- Preview server (if still needed): `~/workspace/phase-android`, port 8080.

## Reproducing the build
```bash
export JAVA_HOME=$HOME/jdk/jdk-21.0.12.1+1
export ANDROID_HOME=$HOME/android-sdk ANDROID_SDK_ROOT=$HOME/android-sdk
export GRADLE_USER_HOME=/home/hatch/.gradle
export GRADLE_OPTS="-Djava.net.preferIPv4Stack=true"
export PATH=$JAVA_HOME/bin:$PATH
cd ~/workspace/phase-android/android
~/gradle/gradle-8.14.3/bin/gradle assembleDebug --offline
```
Init script `~/.gradle/init.d/local-repo.gradle` points Gradle at `~/maven-local`.
To add a missing dependency: append coordinates to `~/.cache/roots.txt` and run
`python3 ~/workspace/fetch-maven.py`.

## Release signing (free sideload launch) — 2026-09-25
- Direction: no Play Store, no Google fees. Free distribution via sideload (e.g. GitHub Releases).
- Release keystore: `~/workspace/user/keystores/phase-release.jks` (RSA 2048, 25-year validity, alias `phase`, DN: Phase Platforms / Mikyas T, Toronto CA).
- `android/app/build.gradle` has `signingConfigs.release` reading env vars (never committed):
  - `PHASE_KEYSTORE` (path to .jks), `PHASE_KEYSTORE_PASSWORD`, `PHASE_KEY_ALIAS` (default `phase`), `PHASE_KEY_PASSWORD`.
- No Google services / Firebase / Play Billing in the build — nothing to pay or configure.
- Build: `assembleRelease --offline` with the above env vars set.
