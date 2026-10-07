#!/bin/bash
# Dynamic IP Update Script for Calendar Home Server (Alviy DDNS)
# This script updates your DNS record when your IP changes
# Usage: ./update-dynamic-ip.sh

# ============================================
# CONFIGURATION - UPDATE THESE VALUES
# ============================================

# Your domain (configured with Alviy DDNS)
DOMAIN="calendar.your-domain.ru"

# ============================================
# ALVIY DDNS SETUP INSTRUCTIONS
# ============================================
# 1. Register at https://alviy.ru/
# 2. Add your domain (or get subdomain from Alviy)
# 3. Get your DDNS token from Alviy dashboard
# ============================================

# Your Alviy DDNS token
# Get at: https://alviy.ru/dashboard/ddns
ALVIY_TOKEN="YOUR_ALVIY_TOKEN"

# Your Alviy hostname (from Alviy dashboard)
ALVIY_HOSTNAME="your-hostname.alviy.ru"

# Your current IP detection service
IP_SERVICE="https://api.ipify.org"

# ============================================
# SCRIPT STARTS BELOW (DONT MODIFY)
# ============================================

# Get current public IP
CURRENT_IP=$(curl -s $IP_SERVICE)

if [ -z "$CURRENT_IP" ]; then
    echo "Error: Could not detect public IP"
    exit 1
fi

echo "Current IP: $CURRENT_IP"

# Get DNS record IP from Alviy
DNS_IP=$(curl -s "https://api.alviy.ru/v1/ddns/${ALVIY_HOSTNAME}?token=${ALVIY_TOKEN}" | grep -o '"ip":"[^"]*"' | cut -d'"' -f4)

echo "DNS Record IP: ${DNS_IP:-not set}"

# Check if IP changed
if [ "$CURRENT_IP" = "$DNS_IP" ]; then
    echo "IP unchanged, no update needed"
    exit 0
fi

# Update DNS via Alviy
echo "Updating DNS record via Alviy..."

UPDATE_RESPONSE=$(curl -s "https://api.alviy.ru/v1/ddns/${ALVIY_HOSTNAME}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"${ALVIY_TOKEN}\", \"ip\": \"${CURRENT_IP}\"}")

echo "Response: $UPDATE_RESPONSE"

# Check result
if echo "$UPDATE_RESPONSE" | grep -qi "success\|ok\|updated"; then
    echo "DNS updated successfully to $CURRENT_IP"
    exit 0
else
    echo "DNS update failed"
    exit 1
fi