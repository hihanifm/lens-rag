# Python 3.11 — matches `make pip-cache` (--python-version 3.11 / cp311 wheels).
FROM python:3.11-slim

# Proxy build args — passed from docker-compose, empty if not set in .env
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTPS_PROXY \
    NO_PROXY=$NO_PROXY

WORKDIR /app

# Install lab CA cert if present (safe no-op when certs/ is empty).
COPY certs/ /tmp/certs/
RUN if ls /tmp/certs/*.crt 2>/dev/null 1>&2; then \
      cp /tmp/certs/*.crt /usr/local/share/ca-certificates/ && \
      update-ca-certificates; \
    fi && rm -rf /tmp/certs

# Point Python HTTP libraries at the system cert bundle for runtime calls.
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

COPY backend/requirements.txt .
COPY pip-cache/ /tmp/pip-cache/

# If wheels were pre-downloaded (make pip-cache), install offline — no network needed.
# Otherwise fall back to PyPI with trusted-host flags for lab proxy environments.
RUN if [ "$(ls /tmp/pip-cache/*.whl /tmp/pip-cache/*.tar.gz 2>/dev/null)" ]; then \
      pip install --no-cache-dir --no-index --find-links /tmp/pip-cache -r requirements.txt; \
    else \
      pip install --no-cache-dir \
        --trusted-host pypi.org \
        --trusted-host pypi.python.org \
        --trusted-host files.pythonhosted.org \
        -r requirements.txt; \
    fi && rm -rf /tmp/pip-cache

COPY backend/ .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
