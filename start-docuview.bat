@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title DocuView

rem ---------------------------------------------------------------------------
rem  Запуск DocuView одним кликом.
rem
rem  Положите этот файл в корень проекта (рядом с package.json) и запускайте
rem  двойным щелчком. Путь определяется от самого файла, поэтому проект можно
rem  перемещать и переименовывать.
rem
rem  Приложение состоит из двух частей: API на порту 4000 и веб на 3000.
rem  Открывать браузер, дождавшись только 3000, бесполезно — страница откроется,
rem  но ни один документ не загрузится.
rem ---------------------------------------------------------------------------

set "PROJECT=%~dp0"
if "%PROJECT:~-1%"=="\" set "PROJECT=%PROJECT:~0,-1%"

rem Запасной путь на случай, если файл запускают не из папки проекта.
if not exist "%PROJECT%\package.json" set "PROJECT=C:\SaaS\rev1\SaasProject_1-main\SaasProject_1-main"

echo.
echo ==========================================
echo           З А П У С К   D O C U V I E W
echo ==========================================
echo.

if not exist "%PROJECT%\package.json" (
    echo [ОШИБКА] Не нашёл package.json.
    echo.
    echo Искал здесь:
    echo   %PROJECT%
    echo.
    echo Положите этот .bat в корень проекта — туда же, где лежит package.json.
    echo.
    pause
    exit /b 1
)

echo Проект: %PROJECT%
pushd "%PROJECT%"

rem --- 1. Node -----------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ОШИБКА] Node.js не найден.
    echo Установите LTS с https://nodejs.org и запустите файл заново.
    echo.
    popd & pause & exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set "NODEVER=%%v"
echo Node.js: !NODEVER!

rem --- 2. Занятые порты --------------------------------------------------------
call :PROBE 3000
if !ERRORLEVEL!==0 (
    echo.
    echo [ВНИМАНИЕ] Порт 3000 уже занят — вероятно, DocuView уже запущен.
    echo Открываю браузер на существующем экземпляре.
    start "" "http://localhost:3000"
    popd & exit /b 0
)

rem --- 3. Зависимости ----------------------------------------------------------
rem Самая частая причина, по которой запуск падал: после распаковки архива
rem с GitHub папки node_modules нет, а npm install в 30 секунд не укладывается.
if not exist "node_modules\.package-lock.json" (
    echo.
    echo Первый запуск: устанавливаю зависимости. Это 2-5 минут, окно не закрывайте.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ОШИБКА] npm install завершился с ошибкой — смотрите текст выше.
        echo.
        popd & pause & exit /b 1
    )
    echo.
    echo Зависимости установлены.
)

rem --- 4. Старт ----------------------------------------------------------------
echo.
echo Запускаю сервер в отдельном окне ^(не закрывайте его^)...
start "DocuView Server" /D "%PROJECT%" cmd /k "npm run dev"

echo.
echo Жду, пока поднимутся обе части приложения:
echo   API  http://localhost:4000
echo   Веб  http://localhost:3000
echo.
echo Первый запуск дольше обычного — Next.js компилирует страницы.
echo.

set "API_UP="
set "WEB_UP="

rem 180 попыток по секунде: обычный старт 15-40 с, первая сборка бывает до 2 минут.
for /l %%i in (1,1,180) do (
    if not defined API_UP (
        call :PROBE 4000
        if !ERRORLEVEL!==0 (
            set "API_UP=1"
            echo   [OK] API   поднялся
        )
    )
    if not defined WEB_UP (
        call :PROBE 3000
        if !ERRORLEVEL!==0 (
            set "WEB_UP=1"
            echo   [OK] Веб   поднялся
        )
    )
    if defined API_UP if defined WEB_UP goto READY

    set /a REM_TICK=%%i %% 15
    if !REM_TICK!==0 echo   ... ждём, прошло %%i с

    timeout /t 1 /nobreak >nul
)

rem --- Не дождались -----------------------------------------------------------
echo.
echo ==========================================
echo  СЕРВЕР НЕ ПОДНЯЛСЯ ЗА 3 МИНУТЫ
echo ==========================================
echo.
if defined API_UP (echo   API 4000: поднялся) else (echo   API 4000: НЕ поднялся)
if defined WEB_UP (echo   Веб 3000: поднялся) else (echo   Веб 3000: НЕ поднялся)
echo.
echo Что делать:
echo   1. Посмотрите окно "DocuView Server" — там текст ошибки.
echo   2. Если ругается на модули: удалите папку node_modules и запустите заново.
echo   3. Если порт занят другой программой: закройте её или перезагрузитесь.
echo.
popd
pause
exit /b 1

rem --- Готово ------------------------------------------------------------------
:READY
echo.
echo ==========================================
echo  ГОТОВО — открываю браузер
echo ==========================================
echo.
echo Рабочий стол:  http://localhost:3000
echo.
echo Перетащите файл в окно браузера — формат определяется по содержимому,
echo выбирать тип документа не нужно.
echo.
echo Чтобы остановить: закройте окно "DocuView Server".
echo.
start "" "http://localhost:3000"
popd
timeout /t 5 /nobreak >nul
exit /b 0

rem ---------------------------------------------------------------------------
rem  Проверка порта. TcpClient отвечает мгновенно, в отличие от
rem  Test-NetConnection, который на закрытом порту ждёт таймаут и растягивает
rem  цикл ожидания в разы.
rem ---------------------------------------------------------------------------
:PROBE
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%1);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
exit /b %ERRORLEVEL%
