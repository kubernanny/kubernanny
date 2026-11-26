# Self-hosted relay

`relay.yaml` runs the Kubernanny relay with a Service, an Ingress (TLS, WebSockets) and a NetworkPolicy. Change the host (in the Ingress and in `RELAY_PUBLIC_URL`), the ingress controller's namespace and the image tag if you want another released version (never `latest`), then `kubectl apply -f relay.yaml`.

Plain Docker on a VPS works just as well (TLS from a reverse proxy in front, e.g. Caddy):

```sh
docker build -f relay/Dockerfile -t kubernanny-relay .
docker run -d --read-only --user 1000 -p 8080:8080 -e RELAY_PUBLIC_URL=https://relay.example.com kubernanny-relay
```

Or a Cloudflare Worker: [`relay/cloudflare/README.md`](../../relay/cloudflare/README.md).

What the relay sees, the limits and their variables, sizing: [docs/RELAY.md](../../docs/RELAY.md).
