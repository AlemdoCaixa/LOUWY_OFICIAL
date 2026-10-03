FROM ubuntu:24.04
ARG WARP_VERSION=2026.7.1377.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg dbus iproute2 nftables microsocks libdbus-1-3 \
    libcap2-bin libnss3 libpcap0.8t64 libtss2-esys-3.0.2-0t64 libtss2-tctildr0t64 \
    && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-warp.gpg \
    && printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-warp.gpg] https://pkg.cloudflareclient.com/ noble main' > /etc/apt/sources.list.d/cloudflare-warp.list \
    && apt-get update \
    && cd /tmp && apt-get download cloudflare-warp=${WARP_VERSION} \
    && dpkg-deb -x cloudflare-warp_${WARP_VERSION}_amd64.deb /tmp/warp \
    && install -m 755 /tmp/warp/bin/warp-svc /usr/bin/warp-svc \
    && install -m 755 /tmp/warp/bin/warp-cli /usr/bin/warp-cli \
    && rm -rf /tmp/warp \
    && rm -f /tmp/cloudflare-warp_*.deb \
    && rm -rf /var/lib/apt/lists/*
COPY start.sh /usr/local/bin/louwy-egress-start
RUN chmod 755 /usr/local/bin/louwy-egress-start \
    && ldd /usr/bin/warp-svc && ldd /usr/bin/warp-cli \
    && ! (ldd /usr/bin/warp-svc; ldd /usr/bin/warp-cli) | grep -q "not found"
EXPOSE 40001
ENTRYPOINT ["/usr/local/bin/louwy-egress-start"]
