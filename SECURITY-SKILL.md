---
name: home-server-deployment
description: "Deploy web apps to home servers with nginx, SSL, and security."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, windows]
metadata:
  hermes:
    tags: [deployment, nginx, ssl, security, windows, linux]
    related_skills: [hermes-agent-skill-authoring]
---

# Home Server Deployment Skill

Deploy web applications to a home server with nginx reverse proxy, HTTPS, IP whitelisting, and security-by-obscurity endpoints.

## When to Use

- Deploying a custom web app to a home server with public access
- Need HTTPS via self-signed or Let's Encrypt certificates  
- Want IP whitelist security (only certain IPs can access)
- Need hidden/obfuscated endpoint paths for security-by-obscurity
- Port forwarding configured on consumer router (TP-Link, etc.)

**Don't use for:** Corporate environments, cloud deployments, complex multi-service architectures.

## Prerequisites

- Public IP address (static or dynamic DNS)
- Router with port forwarding configured (ports 80, 443)
- Domain name pointing to your IP (DuckDNS, No-IP, TP-Link DDNS, Alviy)
- Windows or Linux server access

## Key Concepts

**Security Model:**
1. **Obscured endpoint**: Only `/secret-path/` works, `/other/` returns 404
2. **IP whitelist**: Only your IP can access
3. **SSL/TLS**: Encrypts traffic
4. **Rate limiting**: Prevents abuse

**File Structure:**
```
project/
├── nginx.conf          # Windows/Linux nginx config
├── 404.html           # Custom 404 error page
├── windows-setup.ps1  # Windows automation script
└── SECURITY-SETUP.md  # Step-by-step guide
```

## Procedure

### Step 1: Configure Port Forwarding

On your router:
- Port 80 → Windows IP:80 (HTTP redirect)
- Port 443 → Windows IP:443 (HTTPS)

Find Windows IP:
```bash
# In WSL
ip route show default | grep -oP 'src \K\S+'
```

### Step 2: Set Your Secret Endpoint Path

Choose a hard-to-guess path (NOT `/admin/`, `/secure/`, `/private/`):
- ✅ `/luna-calendar-secure/`
- ✅ `/my-password-2024/`
- ❌ `/admin/` (too common)

Edit `nginx.conf`:
```nginx
location /YOUR_SECRET_PATH/ {
    rewrite ^/YOUR_SECRET_PATH/(.*)$ /$1 break;
```

### Step 3: Install nginx

**Windows:**
```powershell
# Download from https://nginx.org/en/download.html
# Extract to C:\nginx
```

**Linux (WSL/Ubuntu):**
```bash
sudo apt install nginx
sudo cp nginx-calendar.conf /etc/nginx/sites-available/calendar
sudo ln -s /etc/nginx/sites-available/calendar /etc/nginx/sites-enabled/
```

### Step 4: Generate SSL Certificates

**Option A: Self-signed (quick):**
```bash
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout ssl.key -out ssl.crt \
  -subj "/CN=your-domain.ru"
```

**Option B: Let's Encrypt:**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.ru
```

### Step 5: Deploy Your Application

**React/Node.js:**
```bash
npm install -g serve
npm run build
serve -s dist -l 3000
```

**Python/Flask:**
```bash
gunicorn app:app --bind 127.0.0.1:3000
```

### Step 6: Configure nginx.conf

Copy appropriate config:
- Windows: `copy nginx-windows.conf C:\nginx\conf\nginx.conf`
- Linux: `sudo cp nginx-calendar.conf /etc/nginx/sites-available/`

Update placeholders:
- `server_name` → your domain
- Secret endpoint path
- IP whitelist (e.g., `allow 123.45.67.89;`)

### Step 7: Start nginx

```bash
# Linux
sudo nginx -t && sudo systemctl restart nginx

# Windows (Admin PowerShell)
cd C:\nginx
.\nginx.exe
```

## Quick Reference

```bash
# Test nginx config
sudo nginx -t

# Reload nginx
sudo nginx -s reload

# Check if port 443 is open
nmap -p 443 your-domain.ru

# Test HTTPS with secret path
curl -k https://your-domain.ru/secret-path/

# Test 404 on wrong path
curl -k https://your-domain.ru/wrong-path/
```

## Pitfalls

1. **WSL vs Windows networking**: WSL IPs are different from Windows IPs. Port forwards go to Windows IP, not WSL IP. Run apps on Windows if port forwarding is to Windows.

2. **Certificate warnings**: Self-signed certs show "Not Secure" in browsers. Add exception or use Let's Encrypt.

3. **IP changes**: If using dynamic IP, use DDNS (Alviy for Russia) to auto-update your domain.

4. **Secret path leaks**: Never commit the secret path to version control. Store in environment variables or docs with restricted access.

5. **Firewall blocking**: Ensure Windows Firewall allows ports 80, 443, and app port (e.g., 3000).

## Verification

1. ✅ `curl -I http://your-domain.ru/` returns 301 redirect to HTTPS
2. ✅ `curl -k https://your-domain.ru/secret-path/` returns 200 with your app
3. ✅ `curl -k https://your-domain.ru/wrong-path/` returns 404
4. ✅ Access from iPhone: `https://your-domain.ru/secret-path/` loads app

## Related Files

- `SECURITY-SETUP-GUIDE.md` - Detailed step-by-step instructions
- `nginx-windows.conf` - Windows nginx configuration
- `404-windows.html` - Custom error page
- `windows-setup.ps1` - PowerShell automation script
- `update-dynamic-ip.sh` - Alviy DDNS update script