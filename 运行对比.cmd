@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and try again.
  pause
  exit /b 1
)
set /p ITEM=Enter product ID: 
if "%ITEM%"=="" (
  echo Product ID is required.
  pause
  exit /b 1
)
node browser.js --type parent_asin --value "%ITEM%" --period prev30
if errorlevel 1 (
  echo.
  echo Browser collection did not finish. The crawler needs its request template.
  pause
  exit /b 1
)
node crawler.js
echo.
pause
