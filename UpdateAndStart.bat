@echo off
pushd %~dp0
git --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [91mGit is not installed on this system.[0m
    echo Install it from https://git-scm.com/downloads
    goto end
) else (
    if not exist .git (
        echo [91mNot running from a Git repository. Reinstall using an officially supported method to get updates.[0m
        echo See: https://docs.sillytavern.app/installation/windows/
        goto end
    )
    call git pull --rebase --autostash
    if %errorlevel% neq 0 (
        REM incase there is still something wrong
        echo [91mThere were errors while updating.[0m
        echo See the update FAQ at https://docs.sillytavern.app/installation/updating/
        goto end
    )
)
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
node server.js %*
:end
pause
popd
