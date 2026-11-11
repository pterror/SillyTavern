@echo off
where pnpm >nul 2>&1
if %errorlevel% equ 0 (
    call pnpm %*
) else (
    where corepack >nul 2>&1
    if errorlevel 1 (
        echo pnpm could not be found in PATH, and this Node.js has no corepack to run it with. Install pnpm from https://pnpm.io/installation
        exit /b 127
    )
    set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    call corepack pnpm %*
)
exit /b %errorlevel%
