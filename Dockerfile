# Guaruna — self-host image.
# A single uvicorn process serves the static tools AND the GPX database API
# (app.py mounts the static site at "/" when GUARUNA_SERVE_STATIC=1, the default).
FROM python:3.12-slim

WORKDIR /app

# Install Python deps first (better layer caching)
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

# Copy the app + static site
COPY . .

# Writable runtime dirs (SQLite db + uploads + photos); also mounted as volumes in compose
RUN mkdir -p server/data public/routes/uploads public/routes/uploads/photos

ENV GUARUNA_SERVE_STATIC=1
EXPOSE 8001
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8001"]
