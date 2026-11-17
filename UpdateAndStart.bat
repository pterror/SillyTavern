@echo off
call "%~dp0Start.bat" --update %*
exit /b %errorlevel%
