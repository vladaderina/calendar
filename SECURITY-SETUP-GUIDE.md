# 🔒 Calendar Security Setup (WSL + Windows Port Forwarding)

## ✅ Your Configuration
- **Public IP:** 78.29.33.110
- **Domain:** lunxhome.tplinkdns.com
- **Port Forwarding:** Router 443 → Windows → WSL (nginx)
- **Secret Endpoint:** /luna-calendar-secure/

---

## 🚀 Setup Instructions

### Step 1: Deploy nginx in WSL

```bash
# Make script executable
chmod +x /home/vlada/calendar/wsl-setup.sh

# Run setup
./wsl-setup.sh
```

Or manually:
```bash
# Install nginx
sudo apt update && sudo apt install nginx

# Create directories
sudo mkdir -p /etc/nginx/ssl /var/www/calendar

# Copy config
sudo cp nginx-wsl.conf /etc/nginx/sites-available/calendar
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/calendar /etc/nginx/sites-enabled/calendar

# Generate SSL
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/privkey.pem \
  -out /etc/nginx/ssl/fullchain.pem \
  -subj "/CN=lunxhome.tplinkdns.com"

# Create 404 page
sudo mkdir -p /var/www/calendar
# Copy 404.html content manually or use the file provided
```

---

### Step 2: Set up Windows Port Forwarding

On Windows (PowerShell as Administrator):
```powershell
# Find WSL IP (usually starts with 172.16-)
Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -like "*vEthernet*" -or $_.IPAddress -like "172*"} | Select-Object IPAddress

# Or use this command:
wsl hostname -I
```

Then run on Windows (as Administrator):
```cmd
windows-port-forward.bat
```

Or manual setup:
```cmd
# Set WSL IP (replace with actual WSL IP)
set WSL_IP=172.25.X.XX

# Add port forwarding
netsh interface portproxy add v4tov4 listenport=443 connectaddress=%WSL_IP% connectport=443
netsh interface portproxy add v4tov4 listenport=80 connectaddress=%WSL_IP% connectport=80

# Enable firewall
netsh advfirewall firewall add rule name="WSL HTTPS" dir=in action=allow protocol=TCP localport=443
netsh advfirewall firewall add rule name="WSL HTTP" dir=in action=allow protocol=TCP localport=80
```

---

### Step 3: Start Calendar Application

On Windows PowerShell:
```powershell
# Build and serve the calendar app
cd C:\Users\vlada\calendar
npm install -g serve
npm run build
serve -s dist -l 3000
```

Or run in background:
```powershell
# Install pm2
npm install -g pm2
pm2 serve dist 3000 --name calendar
pm2 startup
```

---

### Step 4: Start nginx in WSL

```bash
# Start nginx
sudo nginx

# Or reload if already running
sudo nginx -s reload

# Check status
sudo service nginx status
```

---

## 📱 iPhone Access

**Bookmark:** `https://lunxhome.tplinkdns.com/luna-calendar-secure/`

---

## 🔒 Security Features

✅ **IP Whitelist** - Only 78.29.33.110 can access
✅ **Secret Path** - `/luna-calendar-secure/` (no one can guess)
✅ **Self-signed SSL** - HTTPS encryption
✅ **Security Headers** - XSS, clickjacking protection
✅ **Rate Limiting** - 20 req/s max
✅ **404 by Default** - Normal paths return 404

---

## 🎯 Access Flow

```
Internet → Port 443 (Router) → Windows → Port 3000 (WSL nginx) → Calendar
           ↳ Port 80 (Router) → Windows → Port 80 (WSL nginx) → 301 redirect to HTTPS
```

**Success:** `https://lunxhome.tplinkdns.com/luna-calendar-secure/`
**Blocked:** `https://lunxhome.tplinkdns.com/` → 404

---

## 🔄 Change Secret Path

Edit WSL file:
```bash
sudo nano /etc/nginx/sites-available/calendar
```
Change `location /luna-calendar-secure/` to your new path, then:
```bash
sudo nginx -t && sudo nginx -s reload
```

---

## 🛠️ Troubleshooting

| Issue | Check |
|-------|-------|
| Page not loading | `sudo nginx -t` (test config) |
| 404 everywhere | Script ran, check `location` block |
| SSL warning | iPhone: Accept certificate, or use Let's Encrypt |
| Connection refused | WSL nginx running? `sudo service nginx status` |
| Port not forwarding | Windows: `netsh interface portproxy show all` |

---

## 📂 Files Provided

- `nginx-wsl.conf` - Linux/WSL nginx config
- `404.html` - Custom error page
- `windows-port-forward.bat` - Windows port forwarding script
- `wsl-setup.sh` - Automated WSL setup
- `.env.example` - Updated environment variables
- `SECURITY-SETUP-GUIDE.md` - This guide

---

## 📞 Need Help?

1. Check WSL is running: `wsl` or `lsb_release -a`
2. Verify nginx: `sudo nginx -t`
3. Test locally: `curl -k https://localhost:443/luna-calendar-secure/`
4. Check Windows forwards: `netsh interface portproxy show all`