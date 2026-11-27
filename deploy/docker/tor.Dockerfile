# A Tor client whose SOCKS port is reachable from the other container on the private network.
# Built on the machine where this was written; never started there (it would join the real Tor network).
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install --yes --no-install-recommends tor \
 && rm -rf /var/lib/apt/lists/*
USER debian-tor
VOLUME /var/lib/tor
# The port is not published to the host (deploy/compose.yaml gives this service no ports).
CMD ["tor", "--SocksPort", "0.0.0.0:9050", "--DataDirectory", "/var/lib/tor", "--Log", "notice stdout"]
