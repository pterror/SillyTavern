@echo off
setlocal
pushd "%~dp0" || exit /b 1
node scripts\start.mjs %*
set "START_EXIT_CODE=%errorlevel%"
pause
popd
exit /b %START_EXIT_CODE%
