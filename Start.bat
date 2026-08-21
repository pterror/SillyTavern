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

node server.js %*
pause
popd
