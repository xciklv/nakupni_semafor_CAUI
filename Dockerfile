# Nákupní semafor v n8n: oficiální obraz n8n + kód kontroly. Workflow se sestaví a naimportuje při startu kontejneru (docker/start.sh),
# takže nastavení z .env (limit kontrol, modely, ukládání průběhů) platí hned po restartu bez nového sestavení obrazu.
FROM docker.n8n.io/n8nio/n8n:2.17.6

USER root
RUN mkdir -p /opt/semafor && chown node:node /opt/semafor
USER node

COPY --chown=node:node engine /opt/semafor/engine
COPY --chown=node:node build /opt/semafor/build
COPY --chown=node:node web /opt/semafor/web
COPY --chown=node:node tools/page-reader /opt/semafor/tools/page-reader
COPY --chown=node:node docker/start.sh /opt/semafor/start.sh

WORKDIR /opt/semafor
ENTRYPOINT ["/bin/sh", "/opt/semafor/start.sh"]
