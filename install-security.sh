#!/bin/bash
# Calendar Security Installation Script (TP-Link DDNS - Russia)
# Run as: sudo bash install-security.sh

set -e

echo "🔒 Calendar Security Setup (TP-Link DDNS)"
echo "========================================"
echo ""
echo "Your Configuration:"
echo "  Domain: lunxhome.tplinkdns.com"
echo "  IP: 78.29.33.110"
echo "  Port: 443 (HTTPS)"
echo ""

# Your secret endpoint - CHANGE THIS BEFORE DEPLOYING!
SECRET_ENDPOINT="secure-view"

echo "Secret endpoint: /$SECRET_ENDPOINT/"
echo ""
echo "Continue? (y/n)"
read -r response
if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 1
fi

echo ""
echo "Step 1: Installing prerequisites..."
apt update -qq
apt install -y -qq nginx certbot python3-certbot-nginx > /dev/null

echo "Step 2: Creating directories..."
mkdir -p /var/www/calendar
mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled

echo "Step 3: Installing nginx config..."
cp nginx-calendar.conf /etc/nginx/sites-available/calendar

# Replace placeholder values
sed -i "s/lunxhome.tplinkdns.com/lunxhome.tplinkdns.com/g" /etc/nginx/sites-available/calendar
sed -i "s/loc\/YOUR_SECRET_ENDPOINT\//loc\/$SECRET_ENDPOINT\//g" /etc/nginx/sites-available/calendar
sed -i "s/allow YOUR_HOME_IP;/allow 78.29.33.110;/g" /etc/nginx/sites-available/calendar

echo "Step 4: Enabling site..."
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/calendar /etc/nginx/sites-enabled/calendar

echo "Step 5: Creating error pages..."
cp 404.html /var/www/calendar/

echo "Step 6: Testing nginx..."
nginx -t

echo "Step 7: Starting nginx..."
systemctl reload nginx || systemctl start nginx

echo ""
echo "✅ Nginx installed! Next steps:"
echo ""
echo "1. Get SSL certificate:"
echo "   sudo certbot --nginx -d lunxhome.tplinkdns.com"
echo ""
echo "2. Deploy calendar app on Windows:"
echo "   cd c:\\Users\\vlada\\calendar"
echo "   npm install"
echo "   npm run build"
echo "   npx serve -s dist -l 443"
echo ""
echo "3. Test on iPhone:"
echo "   https://lunxhome.tplinkdns.com/$SECRET_ENDPOINT/"
echo ""
echo "4. Change secret endpoint if needed (edit /etc/nginx/sites-available/calendar)"
echo ""
echo "🎉 Done! Your calendar is ready."