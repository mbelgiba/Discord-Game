@echo off
title XO Arena Server
echo ==============================================
echo        XO Arena - Автоматический Запуск
echo ==============================================
echo.
cd /d "%~dp0"
if not exist node_modules (
    echo [INFO] Папка node_modules отсутствует. Устанавливаем библиотеки...
    call npm install
)
echo.
echo [OK] Запускаем сервер XO Arena...
echo Локальный адрес: http://localhost:3000
echo.
call npm start
pause
