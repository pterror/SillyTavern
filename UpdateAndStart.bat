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
set NODE_ENV=production
rem typescript/eslint in node_modules means a developer installed the dev dependencies on purpose - don't prune them.
rem --include=dev overrides the dev omission NODE_ENV=production implies, so the server still runs as production.
set NPM_DEV_FLAG=--omit=dev
if exist "node_modules\typescript\" set NPM_DEV_FLAG=--include=dev
if exist "node_modules\eslint\" set NPM_DEV_FLAG=--include=dev
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress %NPM_DEV_FLAG% --ignore-scripts
set NPM_DEV_FLAG=
node server.js %*
:end
pause
popd
