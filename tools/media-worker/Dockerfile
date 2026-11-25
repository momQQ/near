# Изолированный worker: без сети наружу, кроме Supabase и OpenAI; без root; лимиты CPU/памяти — в run.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json worker.mjs ./
USER node
ENV WORKER_CPU_SEC=120 WORKER_MEM_MB=1024 WORKER_TIMEOUT_SEC=180
CMD ["node", "worker.mjs"]
# пример: docker run -d --read-only --tmpfs /tmp --cpus 1 --memory 1500m --pids-limit 64 \
#   -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... -e OPENAI_API_KEY=... near-media-worker
