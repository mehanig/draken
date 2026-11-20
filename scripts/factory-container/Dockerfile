FROM node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN mkdir -p /factory /out && chown 65532:65532 /out
COPY stage.cjs proxy.cjs /factory/
USER 65532:65532
WORKDIR /factory
CMD ["node", "/factory/stage.cjs"]
