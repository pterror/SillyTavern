@echo off
pushd %~dp0
set NODE_ENV=production
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts

rem --ignore-scripts above means better-sqlite3's native .node addon never gets auto-built/rebuilt on install,
rem so a missing/broken binding would otherwise stay silently broken forever (search falls back to slower
rem Fuse.js every launch, with no fix-it path). Probe it the same way the server does at runtime, and only pay
rem the rebuild cost on the launches where it's actually needed - a working binding costs nothing extra here.
node src\probe-better-sqlite3.js >nul 2>&1
if errorlevel 1 (
    echo better-sqlite3 native binding is missing or broken, attempting a rebuild...
    rem This repo's .npmrc sets ignore-scripts=true ^(so arbitrary deps can't run install scripts^), but
    rem better-sqlite3's actual build step - "prebuild-install ^|^| node-gyp rebuild --release" - IS its
    rem package.json install script, so it needs that override here or this rebuild is a silent no-op.
    call npm rebuild better-sqlite3 --ignore-scripts=false
    if errorlevel 1 (
        echo better-sqlite3 rebuild failed - character/group search will fall back to the slower Fuse.js search. This usually means no C/C++ compiler toolchain and/or Python 3 is installed.
    ) else (
        echo better-sqlite3 rebuild finished.
    )
)

rem Same shape as the better-sqlite3 block above. inotify-remastered-plus is `os: linux`-gated in its own
rem package.json, so on a real Windows launch this probe always exits 0 immediately and the block below never
rem actually does anything - kept here anyway for symmetry with start.sh and any non-native-Windows environment
rem this same batch file might run under.
node src\probe-inotify-remastered-plus.js >nul 2>&1
if errorlevel 1 (
    echo inotify-remastered-plus native binding is missing, unpatched, or broken, attempting a rebuild...
    rem patch-package with NO package-name argument is its apply mode - see start.sh's own comment on why
    rem passing a package name here instead would silently do the wrong thing (its GENERATE mode).
    call npx patch-package >nul 2>&1
    call npm rebuild inotify-remastered-plus --ignore-scripts=false
    if errorlevel 1 (
        echo inotify-remastered-plus rebuild failed - the local-import directory scanner will fall back to its periodic backstop pass alone. This usually means no C/C++ compiler toolchain and/or Python 3 is installed.
    ) else (
        echo inotify-remastered-plus rebuild finished.
    )
)

node server.js %*
pause
popd
