@echo off
REM Calendar Windows Setup Script
REM Run as Administrator

echo ========================================
echo Календарь: Установка nginx для Windows
echo ========================================
echo.

REM Your configuration
set DOMAIN=lunxhome.tplinkdns.com
set SECRET_PATH=luna-calendar-secure
set APP_PORT=3000
set EXTERNAL_PORT=443
set WHITELIST_IP=78.29.33.110

echo Конфигурация:
echo   Домен: %DOMAIN%
echo   Секретный путь: /%SECRET_PATH%/
echo   APP порт: %APP_PORT%
echo   Внешний порт: %EXTERNAL_PORT%
echo   IP whitelist: %WHITELIST_IP%
echo.

echo 1. Скачивание nginx для Windows...
powershell -Command "Invoke-WebRequest -Uri 'https://nginx.org/download/nginx-1.27.2.zip' -OutFile 'C:\nginx.zip'"
powershell -Command "Expand-Archive -Path 'C:\nginx.zip' -DestinationPath 'C:\nginx'"
del C:\nginx.zip

echo.
echo 2. Создание директорий...
mkdir C:\nginx\ssl 2>nul
mkdir C:\nginx\www 2>nul
mkdir C:\nginx\logs 2>nul

echo.
echo 3. Копирование конфигурации...
copy /Y "nginx-windows.conf" "C:\nginx\conf\nginx.conf"
copy /Y "404-windows.html" "C:\nginx\www\404.html"

echo.
echo 4. Создание SSL сертификатов (самоподписанные)...
powershell -Command &^
    "New-SelfSignedCertificate -Type RSA -Subject 'CN=%DOMAIN%' `
    -CertStoreLocation 'Cert:\LocalMachine\My' `
    -FriendlyName 'Calendar SSL' -NotAfter (Get-Date).AddYears(1)"

echo.
echo 5. Экспорт сертификата...
powershell -Command &^
    "Get-ChildItem -Path Cert:\LocalMachine\My | Where-Object {$_.Subject -like '*%DOMAIN%*'} | `
    ForEach-Object { $_.Thumbprint }" > C:\nginx\thumbprint.txt
set /p THUMBPRINT=<C:\nginx\thumbprint.txt

powershell -Command &^
    "$cert = Get-Item 'Cert:\LocalMachine\My\%THUMBPRINT%'; `
    $cert.Export('Cert', 'C:\nginx\ssl\privkey.pfx') | `
    ForEach-Object { [System.IO.File]::WriteAllBytes('C:\nginx\ssl\privkey.pfx', $_.RawData) }"

echo.
echo 6. Установка nginx в систему...
sc create nginx binPath= "C:\nginx\nginx.exe" start= auto
sc start nginx

echo.
echo ========================================
echo Установка завершена!
echo ========================================
echo.
echo Следующие шаги:
echo 1. Перезапустите приложение календаря на порту 3000
echo 2. Проверьте: https://%DOMAIN%/%SECRET_PATH%/
echo 3. Измените секретный путь в C:\nginx\conf\nginx.conf если нужно
echo.
echo Чтобы перезагрузить nginx:
echo   sc stop nginx
echo   sc start nginx
echo.
pause