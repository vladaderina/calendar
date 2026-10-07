@echo off
REM Generate SSL certificates for nginx on Windows
REM Requires OpenSSL installed (brew install openssl or download from https://slproweb.com/products/Win32OpenSSL.html)

set DOMAIN=lunxhome.tplinkdns.com
set SSL_DIR=C:\nginx\ssl

echo ========================================
echo Генерация SSL сертификатов для %DOMAIN%
echo ========================================

REM Create directories
if not exist "%SSL_DIR%" mkdir "%SSL_DIR%"

REM Generate private key and certificate
openssl req -x509 -nodes -days 365 -newkey rsa:4096 ^
  -keyout "%SSL_DIR%\privkey.pem" ^
  -out "%SSL_DIR%\fullchain.pem" ^
  -subj "/CN=%DOMAIN%/C=RU/ST=City/L=City"

echo.
echo Сертификаты созданы:
echo   Private key: %SSL_DIR%\privkey.pem
echo   Certificate: %SSL_DIR%\fullchain.pem
echo   Chain: %SSL_DIR%\fullchain.pem (includes chain)
echo.
echo Для nginx:
echo   ssl_certificate %SSL_DIR%\fullchain.pem;
echo   ssl_certificate_key %SSL_DIR%\privkey.pem;
echo.
pause