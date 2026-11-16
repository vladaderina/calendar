# --- Этап 1: Сборка ---
# Образы берём через mirror.gcr.io, а не с registry-1.docker.io: демон Docker на
# этом сервере не может завершить TLS-рукопожатие с Docker Hub (TLS 1.3 vs
# Cloudflare), и сборка падает с "failed to fetch anonymous token: TLS handshake
# timeout". Зеркало gcr.io отдаёт те же образы и доступно.
FROM mirror.gcr.io/node:20-alpine AS build
WORKDIR /app

# Копируем файлы зависимостей для кэширования слоёв
COPY package.json package-lock.json ./
RUN npm ci

# Копируем исходники и собираем проект
COPY . .
RUN npm run build

# --- Этап 2: Раздача через Nginx ---
FROM mirror.gcr.io/nginx:alpine

# Копируем собранную статику из первого этапа
COPY --from=build /app/dist /usr/share/nginx/html/luna-calendar-secure

# Копируем ваш конфиг Nginx (если он нужен для SPA-роутинга)
# COPY nginx-calendar.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
