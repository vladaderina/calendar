# Запуск и обновление сервера (календарь + меню одним стеком)

Оба приложения живут в одном `docker-compose.yml` в домашнем каталоге сервера.
Каждое — свой контейнер, свой порт, свой HTTPS-сертификат (он один на оба,
выписан на домен, а не на порт).

| Приложение | Контейнер | Порт снаружи | Адрес |
|---|---|---|---|
| Календарь | `calendar-container` | 18543 | https://78.29.33.110.sslip.io:18543/luna-calendar-secure/ |
| Меню | `recipes-container` | 48291 | https://78.29.33.110.sslip.io:48291/luna-menu-secure/ |

## Что лежит на сервере

```
/home/vlada/
├── docker-compose.yml     ← один стек на два приложения
├── calendar-src/          ← исходники календаря (Dockerfile, nginx-https.conf)
└── recipes-src/           ← исходники меню (Dockerfile, nginx-https.conf, .env)
```

`docker-compose.yml` — копия файла `calendar/deploy/docker-compose.yml` из репозитория.
Если правите его в репозитории, скопируйте заново:

```bash
cp ~/calendar-src/deploy/docker-compose.yml ~/docker-compose.yml
```

## Обычное обновление (после переноса новых файлов)

Файлы обоих проектов переносятся в `~/calendar-src/` и `~/recipes-src/` как раньше
(rsync или WinSCP). Дальше — одна команда из домашнего каталога:

```bash
cd ~ && docker compose up -d --build --force-recreate
```

Compose пересоберёт только изменившиеся образы и перезапустит контейнеры.
Первый запуск после правок в зависимостях занимает несколько минут.

## Проверка

```bash
cd ~
docker compose ps                     # оба контейнера Up (healthy)
curl -k -o /dev/null -w '%{http_code}\n' https://127.0.0.1:18543/luna-calendar-secure/
curl -k -o /dev/null -w '%{http_code}\n' https://127.0.0.1:48291/luna-menu-secure/
```

Оба запроса должны вернуть `200`. `-k` нужен потому, что сертификат выписан
на домен `78.29.33.110.sslip.io`, а не на `127.0.0.1`.

## Тонкости

- **Не запускайте `docker compose` внутри `calendar-src/` или `recipes-src/`.**
  Там остались старые compose-файлы на каждый проект; контейнеры теперь принадлежат
  стеку из `~/docker-compose.yml`, и запуск из подпапки упадёт с ошибкой
  «container name already in use».
- **Порты менять нельзя без причины.** 48291 и 18543 уже проброшены на роутере,
  8080 на сервере занят kanboard.
- **Сертификат** берётся из `/etc/letsencrypt` (монтируется в контейнеры только
  для чтения). Продление — как обычно, `certbot renew`; перезапуск контейнеров
  после продления не нужен, nginx читает файлы при старте, поэтому раз в пару
  месяцев стоит сделать `cd ~ && docker compose restart`.
- **Логин-пароли и ключи Supabase** лежат в `~/recipes-src/.env` и
  `~/calendar-src/.env` (в репозиторий и в rsync не попадают).
- **После перехода меню на HTTPS** старое приложение, добавленное на главный
  экран телефона по `http://…:48291/…`, работать не будет — это другой адрес.
  Откройте новый адрес в браузере и добавьте иконку заново.

## Если что-то не поднялось

```bash
cd ~
docker compose logs --tail 50 recipes      # или calendar
docker compose down && docker compose up -d --build --force-recreate
```
