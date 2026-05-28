#!/bin/bash
clear
echo "=============================================="
echo "       XO Arena - Автоматический Запуск"
echo "=============================================="
echo ""

# Переход в директорию скрипта
cd "$(dirname "$0")"

# Проверка библиотек
if [ ! -d "node_modules" ]; then
    echo "[INFO] Установка недостающих NPM библиотек..."
    npm install
fi

echo ""
echo "[OK] Запускаем сервер XO Arena на http://localhost:3000"
echo "Для завершения работы нажмите Ctrl + C"
echo ""

npm start
