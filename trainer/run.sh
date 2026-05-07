docker build -t deribit-trainer .

docker run -p 8000:8000 \
    -e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/deribit_agent" \
    -e NESTJS_URL="http://host.docker.internal:3030" \
    -e NESTJS_API_KEY="$API_KEY" \
    -v $(pwd)/models:/app/models \
    -t deribit-trainer
    deribit-trainer