FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Collect static assets into STATIC_ROOT for WhiteNoise to serve. Force
# DEBUG=false so the hashed/compressed manifest (staticfiles.json) is produced.
RUN DJANGO_DEBUG=false python manage.py collectstatic --noinput

EXPOSE 8000

# Single ASGI process (Daphne). Keep the deployment at one instance so the
# in-memory channel layer and game state stay consistent for both players.
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "config.asgi:application"]
