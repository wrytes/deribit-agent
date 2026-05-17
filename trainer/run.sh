docker build -t deribit-trainer .

docker run \
    -e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/deribit_agent" \
    -e POLL_INTERVAL=30 \
    -v $(pwd)/models:/app/models \
    -t deribit-trainer \
    deribit-trainer
