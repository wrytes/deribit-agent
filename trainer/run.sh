docker build -t deribit-trainer .
docker run --gpus all -p 8000:8000 \
    -e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/deribit_bot" \
    -v $(pwd)/models:/app/models \
    deribit-trainer