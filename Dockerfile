FROM node:18-alpine as build-dep

# Create app directory
WORKDIR /usr/src/kikoeru

# Install dependencies
COPY package*.json ./

RUN apk add --no-cache python3 make gcc g++ \
    && npm ci --only=production

# Build SPA and PWA
FROM node:14 as build-frontend
WORKDIR /frontend
# @quasar/app v1 requires node-ass, which takes 30 minutes to compile libsass in CI for arm64 and armv7
# So I prebuilt the binaries for arm64 and armv7
# @quasar/app v2 no longer uses this deprecated package, so this line will be removed in the future
ENV SASS_BINARY_SITE="https://github.com/umonaca/node-sass/releases/download"
RUN npm install -g @quasar/cli@2.0.0
RUN git clone https://github.com/MirrichWangD/kikoeru-quasar .
RUN npm ci
RUN quasar build && quasar build -m pwa

# Final stage
FROM node:18-alpine
ENV IS_DOCKER=true
WORKDIR /usr/src/kikoeru

# Copy build artifacts
COPY --from=build-dep /usr/src/kikoeru /usr/src/kikoeru
ARG FRONTEND_TYPE="pwa"
COPY --from=build-frontend /frontend/dist/${FRONTEND_TYPE} /usr/src/kikoeru/dist

# Bundle app source
COPY . .

# Install ffmpeg and tini
RUN apk add --no-cache tini

ENTRYPOINT ["/sbin/tini", "--"]

# 持久化
VOLUME [ "/usr/src/kikoeru/sqlite", "/usr/src/kikoeru/config", "/usr/src/kikoeru/covers"]

EXPOSE 8888
CMD [ "node", "app.js" ]
