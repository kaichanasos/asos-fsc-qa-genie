@echo off
rem Starts QA Genie and opens it in the browser. Keep this window open while using QA Genie; closing it stops QA Genie.
rem Settings, tasks and results live in the data folder next to this file, so everything stays in this one folder.
setlocal
title QA Genie
set "APP=%~dp0app"
set "DATA=%~dp0data"

if not exist "%DATA%" mkdir "%DATA%"
if not exist "%DATA%\.env" copy "%APP%\starter\.env" "%DATA%\.env" >nul
if not exist "%DATA%\qa-genie.config.json" if exist "%APP%\starter\qa-genie.config.json" copy "%APP%\starter\qa-genie.config.json" "%DATA%\" >nul
if not exist "%DATA%\tasks" xcopy "%APP%\starter\tasks" "%DATA%\tasks\" /E /I /Q >nul

cd /d "%DATA%"
echo QA Genie is running. Keep this window open while you use it, and close it when you are done.
echo Your settings, tasks and results are in %DATA%
echo.
"%~dp0node\node.exe" "%APP%\src\server.ts" --open
if errorlevel 1 (
  echo.
  echo QA Genie stopped because of the error above. Send a screenshot of this window to whoever shared QA Genie with you.
  pause
)
