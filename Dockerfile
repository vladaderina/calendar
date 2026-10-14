# --- Этап 1: Сборка ---
FROM node:20-alpine AS build
WORKDIR /app

# Копируем файлы зависимостей для кэширования слоёв
COPY package.json package-lock.json ./
RUN npm ci

# Копируем исходники и собираем проект
COPY . .
RUN npm run build

# --- Этап 2: Раздача через Nginx ---
FROM nginx:alpine

# Копируем собранную статику из первого этапа
COPY --from=build /app/dist /usr/share/nginx/html/luna-calendar-secure

# Копируем ваш конфиг Nginx (если он нужен для SPA-роутинга)
# COPY nginx-calendar.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
