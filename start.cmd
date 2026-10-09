@echo off
rem FRANKENSTEIN v0.4 - lokalni server (http://127.0.0.1:4173)
rem Node.js 22+: z PATH, nebo nastavte FR_NODE na cestu k node.exe
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
if defined FR_NODE set "NODE_EXE=%FR_NODE%"
"%NODE_EXE%" --version >nul 2>&1 || (
  echo Node.js nenalezen. Nainstalujte Node.js 22+ nebo nastavte FR_NODE=C:\cesta\k\node.exe
  exit /b 1
)
if /i "%1"=="test" ( "%NODE_EXE%" --test "test/*.test.js" & exit /b %errorlevel% )
if /i "%1"=="preflight" ( "%NODE_EXE%" src\cli\preflight.js & exit /b %errorlevel% )
"%NODE_EXE%" src\server.js
