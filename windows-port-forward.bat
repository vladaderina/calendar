@echo off
REM Windows -> WSL Port Forwarding for Calendar
REM Run this on Windows to forward port 443 to WSL nginx
REM Requires: Administrator privileges, WSL installed

title Calendar Port Forwarding Setup

echo ========================================
echo Windows -> WSL Port Forwarding
echo Calendar Security on lunxhome.tplinkdns.com
echo ========================================
echo.

REM Get WSL IP (the last IP in the WSL default gateway)
for /f "tokens=3" %%a in ('ipconfig ^| findstr /C:"IPv4 Address" ^| findstr "172"') do set WSL_IP=%%a

if not defined WSL_IP (
    echo Cannot detect WSL IP. Trying alternative method...
    for /f "tokens=*" %%a in ('wsl hostname -I 2^>nul') do set WSL_IP=%%a
)

echo Detected WSL IP: %WSL_IP%
echo.

REM Check if WSL IP is valid
if not defined WSL_IP (
    echo ERROR: Cannot find WSL IP address
    echo Make sure WSL is running
    pause
    exit /b 1
)

echo Setting up port forwarding...
echo Forwarding:
echo   External: 443 (HTTPS)
echo   Internal: %WSL_IP%:443 (nginx in WSL)
echo   Also forwarding: 80 (HTTP redirect)
echo.

REM Delete existing port forwards first
netsh interface portproxy delete allfirewall >nul 2>&1

REM Add port forwarding rules
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=%WSL_IP% connectport=443
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=%WSL_IP% connectport=80

REM Enable firewall for port forwarding
netsh advfirewall firewall add rule name="WSL Calendar HTTPS" dir=in action=allow protocol=TCP localport=443
netsh advfirewall firewall add rule name="WSL Calendar HTTP" dir=in action=allow protocol=TCP localport=80

echo.
echo Port forwarding configured!
echo.

REM Show current rules
echo Current port forwarding rules:
netsh interface portproxy show all
echo.

echo ========================================
echo ✅ Setup Complete!
echo ========================================
echo.
echo Next steps:
echo 1. Run nginx in WSL: sudo nginx
echo 2. Or test now with: https://lunxhome.tplinkdns.com:443/
echo 3. Access: https://lunxhome.tplinkdns.com/luna-calendar-secure/
echo.
echo To remove port forwarding:
echo   netsh interface portproxy delete allfirewall
echo.
pause