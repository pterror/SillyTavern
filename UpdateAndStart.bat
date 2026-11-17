@echo off
setlocal
pushd "%~dp0" || exit /b 1
git --version > nul 2>&1
if errorlevel 1 (
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
    if errorlevel 1 (
        REM incase there is still something wrong
        echo [91mThere were errors while updating.[0m
        echo See the update FAQ at https://docs.sillytavern.app/installation/updating/
        goto end
    )
)
call Start.bat %*
set "UPDATE_EXIT_CODE=%errorlevel%"
popd
exit /b %UPDATE_EXIT_CODE%
:end
pause
popd
exit /b 1
