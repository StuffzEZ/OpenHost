# 🚀 OpenHost

OpenHost is a powerful, self-hosted deployment platform designed to be a lightweight alternative to Vercel and Netlify. It allows you to host web applications, backend services, and databases on your own infrastructure using Docker.

![License](https://img.shields.io/badge/license-GPLv3-blue.svg)
![Build](https://img.shields.io/github/actions/workflow/status/StuffzEZ/OpenHost/ci.yml)
![Platform](https://img.shields.io/badge/platform-linux%2Famd64%20%7C%20linux%2Farm64-lightgrey)

## ✨ Features

- **Multi-Framework Support**: Deploy Node.js, Python, React, Next.js, and Static HTML projects.
- **Git Integration**: Deploy directly from any public Git repository.
- **Database Hosting**: One-click provisioning for PostgreSQL, Redis, and MongoDB.
- **Modern Dashboard**: Clean, intuitive UI for managing your projects and databases.
- **Real-time Logs**: Watch your builds and deployments happen live via WebSockets.
- **Custom Subdomains**: Automatically manages Nginx configurations for your projects.
- **Secure**: Admin-protected dashboard with JWT authentication and rate limiting.

## 🛠️ Quick Start

### Prerequisites
- Docker and Docker Compose
- A server with ports 80 and 443 available

### Standard Installation

```bash
git clone https://github.com/StuffzEZ/OpenHost.git
cd OpenHost
docker-compose up -d
```

Access the dashboard at `http://your-server-ip`.
- **Default User**: `admin@openhost.local`
- **Default Password**: `admin123`

---

## 🏠 CasaOS Installation

OpenHost is fully compatible with CasaOS. You can install it using the custom App Store or by importing the Docker Compose file.

1. Open **CasaOS Dashboard**.
2. Click **App Store** -> **Custom Install** (top right).
3. Select **Import** and paste the contents of `casaos-compose.yml`.
4. Click **Submit** and then **Install**.

---

## ⚙️ Configuration

Environment variables can be adjusted in your `docker-compose.yml`:

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Secret key for auth tokens | `change-this-secret-key` |
| `ADMIN_EMAIL` | Initial admin email | `admin@openhost.local` |
| `ADMIN_PASSWORD` | Initial admin password | `admin123` |
| `POSTGRES_PASSWORD` | Internal database password | `changeme123` |

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the **GNU GPLv3** License - see the [LICENSE](LICENSE) file for details.
