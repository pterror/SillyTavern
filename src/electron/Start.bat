@echo off
pushd %~dp0
if exist "node_modules\" if not exist "node_modules\.modules.yaml" rmdir /s /q node_modules
call ..\..\scripts\pnpm.cmd install --frozen-lockfile --loglevel=error --prod --ignore-scripts
call ..\..\scripts\pnpm.cmd run start server.js %*
pause
popd
