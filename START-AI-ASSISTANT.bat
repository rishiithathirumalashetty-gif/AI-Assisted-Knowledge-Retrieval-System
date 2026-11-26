@echo off
rem Local verification for AI-Assisted Knowledge Retrieval System.
rem Installs dependencies, runs tests and build, starts both servers and runs the smoke test.
rem All output goes to the logs folder.
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs
del /q logs\*.log logs\*.txt 2>nul
echo started %date% %time% > logs\status.txt

echo [1/7] Checking Node.js and npm...
node -v > logs\node-version.txt 2>&1
call npm -v >> logs\node-version.txt 2>&1
type logs\node-version.txt

echo [2/7] Installing backend dependencies...
cd backend
call npm install > ..\logs\backend-install.log 2>&1
echo backend-install exit %errorlevel% >> ..\logs\status.txt

echo [3/7] Running backend tests...
call npm test > ..\logs\backend-test.log 2>&1
echo backend-test exit %errorlevel% >> ..\logs\status.txt

echo [4/7] Installing frontend dependencies...
cd ..\frontend
call npm install > ..\logs\frontend-install.log 2>&1
echo frontend-install exit %errorlevel% >> ..\logs\status.txt

set NODE_OPTIONS=--openssl-legacy-provider
echo [5/7] Running frontend tests and production build...
call npx ng test --watch=false --browsers=ChromeHeadlessCI > ..\logs\frontend-test.log 2>&1
echo frontend-test exit %errorlevel% >> ..\logs\status.txt
call npm run build > ..\logs\frontend-build.log 2>&1
echo frontend-build exit %errorlevel% >> ..\logs\status.txt

echo [6/7] Starting backend (port 3000) and frontend (port 4200) in new windows...
cd ..
start "AI Assistant backend" cmd /k "cd /d %~dp0backend && set OLLAMA_MODEL=qwen2.5-coder:7b&& npm start"
start "AI Assistant frontend" cmd /k "cd /d %~dp0frontend && set NODE_OPTIONS=--openssl-legacy-provider && npm start"

echo Waiting for the backend...
set tries=0
:waitbackend
set /a tries+=1
curl -s http://localhost:3000/health > logs\health.txt 2>nul
if errorlevel 1 (
  if %tries% lss 60 (timeout /t 2 /nobreak > nul & goto waitbackend)
)
echo backend-up after %tries% tries >> logs\status.txt

echo Waiting until the qwen2.5-coder:7b model is installed in Ollama...
set mtries=0
:waitmodel
set /a mtries+=1
curl -s http://localhost:11434/api/tags | findstr /c:"qwen2.5-coder:7b" > nul
if errorlevel 1 (
  if %mtries% lss 180 (timeout /t 10 /nobreak > nul & goto waitmodel)
)
echo model-check after %mtries% tries >> logs\status.txt

echo [7/7] Running the smoke test against your real Ollama (this can take a few minutes)...
cd backend
call npm run smoke > ..\logs\smoke.log 2>&1
echo smoke exit %errorlevel% >> ..\logs\status.txt
cd ..
echo finished %date% %time% >> logs\status.txt
type logs\smoke.log
echo Opening the application in your browser...
start "" http://localhost:4200
echo.
echo Done. The backend and frontend keep running in their own windows. You can close this one.
if not defined NONINTERACTIVE pause
