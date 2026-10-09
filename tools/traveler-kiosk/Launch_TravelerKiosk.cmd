@echo off
setlocal
rem SkyNet Traveler Kiosk launcher. Starts Chrome with silent printing
rem (--kiosk-printing) in its own profile and opens the kiosk.
rem
rem   Edit the URL line for where you are:
rem     Dev review   http://localhost:5173/traveler-kiosk   (your Vite dev address)
rem     TEST         https://test-skynet.skybolt.com/traveler-kiosk
rem     PROD / PC    https://skynet.skybolt.com/traveler-kiosk
rem   On the kiosk PC add --kiosk after --kiosk-printing to hide the browser chrome,
rem   and copy a shortcut to this file into shell:startup.
rem
rem Close every normal Chrome window first (tray icon too), then double-click.

set "URL=http://localhost:5173/traveler-kiosk"

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Chrome was not found in the usual places.
  echo Open chrome://version in Chrome, copy the "Executable Path", and edit the CHROME= line in this file.
  pause
  exit /b 1
)

echo Starting the Traveler Kiosk (silent printing, separate profile) at %URL% ...
start "" "%CHROME%" --kiosk-printing --user-data-dir="%LOCALAPPDATA%\SkyNetTravelerKiosk" --no-first-run --no-default-browser-check "%URL%"
timeout /t 5 >nul
endlocal
