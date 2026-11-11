@echo off
pushd %~dp0
rem A node_modules without .modules.yaml was made by npm; pnpm would install around the packages npm left there.
for %%m in (node_modules engine\node_modules tests\node_modules) do (
    if exist "%%m\" if not exist "%%m\.modules.yaml" rmdir /s /q "%%m"
)
set NODE_ENV=production
rem typescript/eslint in node_modules means a developer installed the dev dependencies on purpose - don't prune them.
rem --prod=false overrides the dev omission NODE_ENV=production implies, so the server still runs as production.
set PNPM_PROD_FLAG=--prod
if exist "node_modules\typescript\" set PNPM_PROD_FLAG=--prod=false
if exist "node_modules\eslint\" set PNPM_PROD_FLAG=--prod=false
call scripts\pnpm.cmd install --frozen-lockfile --loglevel=error %PNPM_PROD_FLAG%
set PNPM_PROD_FLAG=

rem The new page's build for this checkout (packages/serve-ui): the one there, else its release's; between releases
rem it's built here, which needs the dev dependencies (installed only then).
node scripts\build-ui.mjs --ensure
if errorlevel 1 (
    echo Installing the tools to build the new page...
    call scripts\pnpm.cmd install --frozen-lockfile --loglevel=error --prod=false
    node scripts\build-ui.mjs --ensure
)

node server.js %*
pause
popd
