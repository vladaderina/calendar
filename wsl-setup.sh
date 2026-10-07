#!/bin/bash
# WSL Setup Script for Calendar nginx
# Run this in WSL after Windows port forwarding is set up

set -e

echo "========================================"
echo "WSL Calendar nginx Setup"
echo "========================================"
echo ""

# Your configuration
DOMAIN="lunxhome.tplinkdns.com"
SECRET_PATH="luna-calendar-secure"
APP_PORT=3000

echo "Configuration:"
echo "  Domain: $DOMAIN"
echo "  Secret Path: /$SECRET_PATH/"
echo "  App Port: $APP_PORT"
echo ""

# Install nginx if not present
if ! command -v nginx &> /dev/null; then
    echo "Installing nginx..."
    sudo apt update
    sudo apt install nginx
fi

# Create directories
sudo mkdir -p /etc/nginx/ssl
sudo mkdir -p /var/www/calendar

# Copy nginx config
echo "Installing nginx configuration..."
sudo cp nginx-wsl.conf /etc/nginx/sites-available/calendar
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/calendar /etc/nginx/sites-enabled/calendar

# Generate self-signed SSL certificate
echo "Generating self-signed SSL certificate..."
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/privkey.pem \
    -out /etc/nginx/ssl/fullchain.pem \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,IP:127.0.0.1" 2>/dev/null || \
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/privkey.pem \
    -out /etc/nginx/ssl/fullchain.pem \
    -subj "/CN=$DOMAIN"

sudo chmod 600 /etc/nginx/ssl/privkey.pem

# Create 404 error page
echo "Creating 404 error page..."
sudo tee /var/www/calendar/404.html > /dev/null << 'HTMLEOF'
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>404 - Доступ ограничен</title>
    <style>
        body { font-family: Arial, sans-serif; background: #1a1a2e; color: #fff;
               display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .container { text-align: center; padding: 2rem; }
        h1 { font-size: 4rem; color: #e74c3c; margin-bottom: 1rem; }
        h2 { color: #bdc3c7; margin-bottom: 1rem; }
        p { color: #95a5a6; }
    </style>
</head>
<body>
    <div class="container">
        <h1>404</h1>
        <h2>Доступ ограничен</h2>
        <p>Используйте правильный секретный путь</p>
    </div>
</body>
</html>
HTMLEOF

# Test nginx config
echo "Testing nginx configuration..."
sudo nginx -t

# Start/reload nginx
echo "Starting nginx..."
if pgrep nginx > /dev/null; then
    sudo nginx -s reload
    echo "✅ nginx reloaded"
else
    sudo service nginx start
    sudo service nginx status
    echo "✅ nginx started"
fi

echo ""
echo "========================================"
echo "✅ WSL Setup Complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. On Windows, run: windows-port-forward.bat (as Administrator)"
echo "2. Access from iPhone: https://$DOMAIN/$SECRET_PATH/"
echo ""
echo "Nginx logs:"
echo "  Error: sudo tail -f /var/log/nginx/error.log"
echo "  Access: sudo tail -f /var/log/nginx/access.log"
echo ""